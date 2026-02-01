import { world, system, ItemStack } from "@minecraft/server";
import { ModalFormData, MessageFormData, ActionFormData } from "@minecraft/server-ui";


const SCAN_RADIUS = 4; 
const BLOCKS_PER_TICK_LIMIT = 2000;

// --- TAGS ---
const ADMIN_TAG              = "Admin";
const SETTINGS_ITEM          = "minecraft:bedrock";
const DISABLE_GHOST_TAG      = "antidupe:disable_ghost";
const DISABLE_PLANT_TAG      = "antidupe:disable_plant";
const DISABLE_HOPPER_TAG     = "antidupe:disable_hopper";
const DISABLE_DROPPER_TAG    = "antidupe:disable_dropper";
const DISABLE_ALERT_TAG      = "antidupe:disable_alert";
const DISABLE_PUBLIC_MSG_TAG = "antidupe:disable_public_msg";
const DISABLE_ADMIN_MSG_TAG  = "antidupe:disable_admin_msg";

// --- SETS & DATA ---
const TWO_HIGH = new Set([
  "minecraft:tall_grass", "minecraft:tall_dry_grass", "minecraft:large_fern",
  "minecraft:sunflower", "minecraft:rose_bush", "minecraft:peony",
  "minecraft:lilac", "minecraft:cornflower", "minecraft:tall_seagrass",
  "minecraft:torchflower_crop", "minecraft:torchflower",
]);

const BUNDLE_TYPES = new Set([
  "minecraft:bundle", "minecraft:red_bundle", "minecraft:blue_bundle",
  "minecraft:black_bundle", "minecraft:cyan_bundle", "minecraft:brown_bundle",
  "minecraft:gray_bundle", "minecraft:green_bundle", "minecraft:lime_bundle",
  "minecraft:light_blue_bundle", "minecraft:light_gray_bundle",
  "minecraft:magenta_bundle", "minecraft:orange_bundle", "minecraft:purple_bundle",
  "minecraft:white_bundle", "minecraft:yellow_bundle", "minecraft:pink_bundle",
]);

const PISTON_OFFSETS = [
  { x:  1, z:  0 }, { x: -1, z:  0 }, { x:  0, z:  1 }, { x:  0, z: -1 },
  { x:  1, z:  1 }, { x: -1, z:  1 }, { x:  1, z: -1 }, { x: -1, z: -1 },
];

// --- LOGGING SYSTEM ---
let dupeLogs = [];
function addDupeLog(entry) {
  dupeLogs.push(entry);
  if (dupeLogs.length > 100) dupeLogs.shift();
}


world.afterEvents.playerSpawn.subscribe(({ player, initialSpawn }) => {
  if (!initialSpawn || !player) return;
  if (player.hasTag(DISABLE_GHOST_TAG)) return;

  const cursor = player.getComponent("cursor_inventory");
  const held   = cursor.item;
  const inv    = player.getComponent("inventory").container;
  const empty  = inv.emptySlotsCount;

  if (held && held.amount === held.maxAmount && empty === 0) {
    player.dimension.spawnItem(new ItemStack(held.typeId, 1), player.location);
    cursor.clear();
    alertDupe(player, "Ghost Stack Dupe", `${held.amount}x ${held.typeId}`, player.location);
  }
});


/**
 * MAIN SCANNER LOOP (GENERATOR) MADE BY EAGLES.
 */
function* mainScanner() {
  while (true) {
    const players = world.getAllPlayers();
    
    for (const player of players) {
      try {
        if (!player) continue;

        const dim = player.dimension;
        const { x: cx, y: cy, z: cz } = player.location;
        const bx = Math.floor(cx);
        const by = Math.floor(cy);
        const bz = Math.floor(cz);
        const checkPlant = !player.hasTag(DISABLE_PLANT_TAG);
        const checkHopper = !player.hasTag(DISABLE_HOPPER_TAG);
        const checkDropper = !player.hasTag(DISABLE_DROPPER_TAG);

        if (!checkPlant && !checkHopper && !checkDropper) continue;

        for (let dx = -SCAN_RADIUS; dx <= SCAN_RADIUS; dx++) {
          for (let dy = -SCAN_RADIUS; dy <= SCAN_RADIUS; dy++) {
            for (let dz = -SCAN_RADIUS; dz <= SCAN_RADIUS; dz++) {
              
              const currentPos = { x: bx + dx, y: by + dy, z: bz + dz };
              const block = dim.getBlock(currentPos);
              
              if (block) {
                const typeId = block.typeId;


                if (typeId.includes("dropper") || typeId.includes("hopper")) {
                }

                if (checkPlant && TWO_HIGH.has(typeId)) {
                  processPlantCheck(player, dim, block, currentPos);
                }
                else if (checkHopper && typeId === "minecraft:hopper") {
                  processHopperCheck(player, block, currentPos);
                }
                else if (checkDropper && typeId === "minecraft:dropper") {
                  processDropperCheck(player, dim, block, currentPos);
                }
              }
              yield; 
            }
          }
        }
      } catch (e) {
        console.warn(`[ERROR] Scanner crashed on player: ${e}`);
        continue;
      }
    }
    yield "FRAME_END";
  }
}

const scanner = mainScanner();

system.runInterval(() => {
  let operations = 0;
  let result = { done: false, value: undefined };

  while (operations < BLOCKS_PER_TICK_LIMIT) {
    result = scanner.next();
    operations++;
    if (result.value === "FRAME_END") break; 
  }
});


function processPlantCheck(player, dim, plantBlock, pos) {
  for (const o of PISTON_OFFSETS) {
    for (const d of [1, 2]) {
      const bx = pos.x + o.x * d;
      const bz = pos.z + o.z * d;
      const nb = dim.getBlock({ x: bx, y: pos.y, z: bz });
      if (!nb) continue;
      if (nb.typeId === "minecraft:piston" || nb.typeId === "minecraft:sticky_piston") {
        nb.setType("minecraft:air");
        console.warn(`[ACTION] Removed Piston at ${bx}, ${pos.y}, ${bz}`);
        alertDupe(player, "Plant Dupe", plantBlock.typeId, pos);
      }
    }
  }
}

function processHopperCheck(player, block, pos) {
  const invComp = block.getComponent("minecraft:inventory");
  if (!invComp) {
      return;
  }
  const cont = invComp.container;
  let wiped = false;
  
  for (let slot = 0; slot < cont.size; slot++) {
    const stack = cont.getItem(slot);
    if (!stack) continue;
    if (BUNDLE_TYPES.has(stack.typeId)) {
      cont.setItem(slot, undefined);
      wiped = true;
    }
  }
  if (wiped) {
    alertDupe(player, "Hopper Bundle Dupe", "Bundle", pos);
  }
}


function processDropperCheck(player, dim, block, pos) {
  const invComp = block.getComponent("minecraft:inventory");
  if (!invComp) return;
  
  const cont = invComp.container;
  let wiped = false;
  
  for (let slot = 0; slot < cont.size; slot++) {
    const stack = cont.getItem(slot);
    if (!stack) continue;
    if (BUNDLE_TYPES.has(stack.typeId)) {
      try {

          dim.spawnItem(stack, { x: pos.x + 0.5, y: pos.y + 1.2, z: pos.z + 0.5 });
      } catch (e) {

      }
      cont.setItem(slot, undefined);
      wiped = true;
    }
  }
  
  if (wiped) {
    alertDupe(player, "Restricted Item (Ejected)", "Bundle", pos);
  }
}

// --- ADMIN / UI UTILS ---

function sendAdminAlert(message) {
  const admins = world.getAllPlayers().filter((p) => p.hasTag(ADMIN_TAG));
  for (const admin of admins) {
    if (admin.hasTag(DISABLE_ADMIN_MSG_TAG) || admin.hasTag(DISABLE_ALERT_TAG)) continue;
    admin.sendMessage(message);
  }
}

function getNearbyPlayers(offender, loc, radius = 50) {
  const players = world.getAllPlayers();
  const nearby = [];
  const r2 = radius * radius;
  for (const p of players) {
    if (p === offender || !p.location) continue;
    const dx = p.location.x - loc.x;
    const dy = p.location.y - loc.y;
    const dz = p.location.z - loc.z;
    if (dx*dx + dy*dy + dz*dz <= r2) nearby.push(p.nameTag);
  }
  return nearby;
}

function alertDupe(offender, dupeType, itemDesc, loc) {
  const coordStr = `${Math.floor(loc.x)}, ${Math.floor(loc.y)}, ${Math.floor(loc.z)}`;
  const nearby   = getNearbyPlayers(offender, loc);
  const nearList = nearby.length > 0 ? nearby.join(", ") : "None";
  
  const broadcastMsg = `§c<Anti-Dupe> §f§l${offender.nameTag}§r §7attempted a ${dupeType} with §f${itemDesc}§r.`;
  const adminMsg = `§c<Anti-Dupe> §6Admin Alert: §f§l${offender.nameTag}§r §7attempted a ${dupeType} with §f${itemDesc}§r at §e§l${coordStr}§r.\n§7Nearby: §e${nearList}§r.`;
  
  addDupeLog(`Anti-Dupe: ${offender.nameTag} | ${dupeType} | ${coordStr}`);

  for (const p of world.getAllPlayers()) {
    if (!p.hasTag(DISABLE_PUBLIC_MSG_TAG)) p.sendMessage(broadcastMsg);
  }
  sendAdminAlert(adminMsg);
}

// --- UI HANDLING ---

async function ForceOpen(player, form, timeout = 1200) {
  const start = system.currentTick;
  while (system.currentTick - start < timeout) {
    const response = await form.show(player);
    if (response.cancelationReason !== "UserBusy") return response;
  }
  return undefined;
}

function openDupeLogsMenu(player) {
  const logEntries = [...dupeLogs].reverse();
  const bodyText = logEntries.length ? logEntries.join("\n") : "No dupe logs.";
  const form = new MessageFormData()
    .title("Dupe Logs")
    .body(bodyText)
    .button1("Close")
    .button2("Clear Logs");

  ForceOpen(player, form).then((res) => {
    if (res && res.selection === 1) {
      dupeLogs = [];
      player.sendMessage("§aLogs Cleared.");
    }
  });
}

function openSettingsForm(player) {
  const form = new ModalFormData()
    .title("Anti-Dupe Config")
    .toggle("Ghost Stack Patch",   !player.hasTag(DISABLE_GHOST_TAG))
    .toggle("Plant Dupe Patch",    !player.hasTag(DISABLE_PLANT_TAG))
    .toggle("Hopper Bundle Patch", !player.hasTag(DISABLE_HOPPER_TAG))
    .toggle("Dropper Bundle Patch",  !player.hasTag(DISABLE_DROPPER_TAG))
    .toggle("Coordinate Alerts",   !player.hasTag(DISABLE_ALERT_TAG))
    .toggle("Public Messages",     !player.hasTag(DISABLE_PUBLIC_MSG_TAG))
    .toggle("Admin Messages",      !player.hasTag(DISABLE_ADMIN_MSG_TAG));

  ForceOpen(player, form).then((response) => {
    if (!response || response.canceled) return;
    const tags = [
      DISABLE_GHOST_TAG, DISABLE_PLANT_TAG, DISABLE_HOPPER_TAG, DISABLE_DROPPER_TAG,
      DISABLE_ALERT_TAG, DISABLE_PUBLIC_MSG_TAG, DISABLE_ADMIN_MSG_TAG
    ];
    response.formValues.forEach((enabled, i) => {
      enabled ? player.removeTag(tags[i]) : player.addTag(tags[i]);
    });
    player.sendMessage("§aSettings Updated.");
  });
}

// Menu Activation
world.beforeEvents.itemUse.subscribe((event) => {
  const { source, itemStack } = event;
  if (!source.hasTag(ADMIN_TAG) || itemStack.typeId !== SETTINGS_ITEM) return;
  event.cancel = true;
  
  system.run(() => {
    const menu = new ActionFormData()
      .title("Anti-Dupe")
      .button("Settings")
      .button("Logs");
    ForceOpen(source, menu).then(res => {
      if (!res || res.canceled) return;
      res.selection === 0 ? openSettingsForm(source) : openDupeLogsMenu(source);
    });
  });
});

world.afterEvents.entityHitBlock.subscribe((event) => {
  const p = event.damagingEntity;
  if (p && p.typeId === "minecraft:player" && p.hasTag(ADMIN_TAG)) {
    const inv = p.getComponent("inventory").container;
    const item = inv.getItem(p.selectedSlot);
    if (item && item.typeId === SETTINGS_ITEM) openDupeLogsMenu(p);
  }
});