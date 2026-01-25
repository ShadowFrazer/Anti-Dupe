import { world, system, ItemStack } from "@minecraft/server";
import { ModalFormData, MessageFormData, ActionFormData } from "@minecraft/server-ui";

/**
 * 1) GHOST‑STACK DETECTION
 */
world.afterEvents.playerSpawn.subscribe(({ player, initialSpawn }) => {
  if (!initialSpawn || !player) return;
  if (player.hasTag(DISABLE_GHOST_TAG)) return;

  const cursor = player.getComponent("cursor_inventory");
  const held   = cursor.item;
  const inv    = player.getComponent("inventory").container;
  const empty  = inv.emptySlotsCount;

  if (held && held.amount === held.maxAmount && empty === 0) {
    world.getDimension("overworld").runCommand(
      `tellraw @a {"rawtext":[{"text":"§c<Anti-Dupe> §f§l${player.nameTag} §cTried To Dupe With §f${held.typeId}§c!"}]}`
    );
    player.dimension.spawnItem(new ItemStack(held.typeId, 1), player.location);
    cursor.clear();

    const loc = player.location;
    const locStr = `${Math.floor(loc.x)}, ${Math.floor(loc.y)}, ${Math.floor(loc.z)}`;
    addDupeLog(`Anti-Dupe: ${player.nameTag} tried to dupe with ${held.typeId} at ${locStr}.`);
    sendAdminAlert(`§c<Anti-Dupe> §f§l${player.nameTag} §7Tried To Dupe With §f${held.typeId} §7at §e${locStr}§7.`);
  }
});

/**
 * 2) PLANT‑DUPE CUTTER
 */
const TWO_HIGH = new Set([
  "minecraft:tall_grass","minecraft:tall_dry_grass","minecraft:large_fern","minecraft:sunflower",
  "minecraft:rose_bush","minecraft:peony","minecraft:lilac","minecraft:cornflower",
  "minecraft:tall_seagrass","minecraft:torchflower_crop","minecraft:torchflower",
]);
const OFFSETS = [
  { x:  1, z:  0 }, { x: -1, z:  0 }, { x: 0, z: 1 }, { x: 0, z: -1 },
  { x:  1, z:  1 }, { x: -1, z:  1 }, { x: 1, z: -1 }, { x: -1, z: -1 },
];
function purgePistons(player, dim, plantBlock) {
  const px = Math.floor(plantBlock.location.x);
  const py = Math.floor(plantBlock.location.y);
  const pz = Math.floor(plantBlock.location.z);

  for (const o of OFFSETS) {
    for (const d of [1, 2]) {
      const bx = px + o.x * d;
      const by = py;
      const bz = pz + o.z * d;
      const nb = dim.getBlock({ x: bx, y: by, z: bz });
      if (!nb) continue;
      const t = nb.typeId;
      if (t === "minecraft:piston" || t === "minecraft:sticky_piston") {
        nb.setType("minecraft:air");
        world.getDimension("overworld").runCommand(
          `tellraw @a {"rawtext":[{"text":"§c<Anti-Dupe> §f§l${player.nameTag} §cTried To Dupe With §f${plantBlock.typeId}§c! Piston Removed."}]}`
        );
        const locStr = `${px}, ${py}, ${pz}`;
        addDupeLog(`Anti-Dupe: ${player.nameTag} tried to dupe with ${plantBlock.typeId} at ${locStr}. Piston removed.`);
        sendAdminAlert(`§c<Anti-Dupe> §f§l${player.nameTag} §7Tried To Dupe With §f${plantBlock.typeId} §7at §e${locStr}§7. Piston Removed.`);
      }
    }
  }
}

/**
 * 3) HOPPER‑BUNDLE PURGE
 */
const BUNDLE_TYPES = new Set([
  "minecraft:bundle","minecraft:red_bundle","minecraft:blue_bundle","minecraft:black_bundle",
  "minecraft:cyan_bundle","minecraft:brown_bundle","minecraft:gray_bundle","minecraft:green_bundle",
  "minecraft:lime_bundle","minecraft:light_blue_bundle","minecraft:light_gray_bundle",
  "minecraft:magenta_bundle","minecraft:orange_bundle","minecraft:purple_bundle",
  "minecraft:white_bundle","minecraft:yellow_bundle","minecraft:pink_bundle",
]);
const HOPPER_SCAN_RADIUS = 5;

// Admin configuration tags
const ADMIN_TAG         = "Admin";
const SETTINGS_ITEM     = "minecraft:bedrock";
const DISABLE_GHOST_TAG = "antidupe:disable_ghost";
const DISABLE_PLANT_TAG = "antidupe:disable_plant";
const DISABLE_HOPPER_TAG= "antidupe:disable_hopper";
const DISABLE_DROPPER_TAG="antidupe:disable_dropper";
const DISABLE_ALERT_TAG = "antidupe:disable_alert";

// Simple in‑memory log capped at 100 entries.
let dupeLogs = [];
function addDupeLog(entry) {
  dupeLogs.push(entry);
  if (dupeLogs.length > 100) dupeLogs.shift();
}
function sendAdminAlert(message) {
  const admins = world.getPlayers ? world.getPlayers({ tags: [ADMIN_TAG] })
                : world.getAllPlayers().filter(p => p.hasTag && p.hasTag(ADMIN_TAG));
  for (const admin of admins) {
    if (admin.hasTag && admin.hasTag(DISABLE_ALERT_TAG)) continue;
    try {
      admin.sendMessage(message);
    } catch {
      const safe = message.replace(/"/g, '\\"');
      try {
        admin.runCommand(`tellraw @s {"rawtext":[{"text":"${safe}"}]}`);
      } catch {}
    }
  }
}
// Helper to repeatedly show a form until the player isn’t busy.
async function ForceOpen(player, form, timeout = 1200) {
  const startTick = system.currentTick;
  while (system.currentTick - startTick < timeout) {
    const resp = await form.show(player);
    if (resp.cancelationReason !== "UserBusy") return resp;
  }
  return undefined;
}
// Display logs in a scrollable two‑button form with a clear option.
function openDupeLogsMenu(player) {
  const logEntries = [...dupeLogs].reverse();
  const logText = [];
  if (logEntries.length === 0) {
    logText.push({ text: "No dupe logs.\n" });
  } else {
    for (const entry of logEntries) {
      logText.push({ text: entry });
      logText.push({ text: "\n" });
    }
  }
  const form = new MessageFormData()
    .title("Dupe Logs")
    .body({ rawtext: logText })
    .button1("Close")
    .button2("Clear Logs");
  system.run(() => {
    ForceOpen(player, form).then(res => {
      if (!res || res.canceled) return;
      if (res.selection === 1) {
        dupeLogs = [];
        try {
          player.sendMessage("§aDupe Logs Cleared.");
        } catch {
          try {
            player.runCommand(`tellraw @s {"rawtext":[{"text":"§aDupe Logs Cleared."}]}`);
          } catch {}
        }
      }
    });
  });
}

/**
 * Helper to open the settings form with toggles.
 */
function openSettingsForm(player) {
  const form = new ModalFormData()
    .title("Anti-Dupe Configuration")
    .toggle("Ghost Stack Patch", { defaultValue: !player.hasTag(DISABLE_GHOST_TAG) })
    .toggle("Plant Dupe Patch", { defaultValue: !player.hasTag(DISABLE_PLANT_TAG) })
    .toggle("Hopper Bundle Patch", { defaultValue: !player.hasTag(DISABLE_HOPPER_TAG) })
    .toggle("Dropper Pair Patch", { defaultValue: !player.hasTag(DISABLE_DROPPER_TAG) })
    .toggle("Coordinate Alerts", { defaultValue: !player.hasTag(DISABLE_ALERT_TAG) });

  system.run(() => {
    ForceOpen(player, form).then((response) => {
      if (!response || response.canceled) return;
      const values = response.formValues;
      const mapping = [
        { enabled: values[0], tag: DISABLE_GHOST_TAG },
        { enabled: values[1], tag: DISABLE_PLANT_TAG },
        { enabled: values[2], tag: DISABLE_HOPPER_TAG },
        { enabled: values[3], tag: DISABLE_DROPPER_TAG },
        { enabled: values[4], tag: DISABLE_ALERT_TAG },
      ];
      for (const entry of mapping) {
        if (entry.enabled) {
          if (player.hasTag(entry.tag)) player.removeTag(entry.tag);
        } else {
          if (!player.hasTag(entry.tag)) player.addTag(entry.tag);
        }
      }
      try {
        player.sendMessage("§aAnti-Dupe Settings Updated.");
      } catch {
        const dim = player.dimension;
        if (dim) {
          dim.runCommand(
            `tellraw @s {"rawtext":[{"text":"§aAnti-Dupe Settings Updated."}]}`
          );
        }
      }
    }).catch((err) => {
      console.warn(`Anti-Dupe settings form error: ${err}`);
    });
  });
}

/**
 * 4) DROPPER PAIR & BUNDLE PURGE
 */
const FACING_VECTORS = {
  0: { x: 0, y:-1, z: 0 }, // down
  1: { x: 0, y: 1, z: 0 }, // up
  2: { x: 0, y: 0, z:-1 }, // north
  3: { x: 0, y: 0, z: 1 }, // south
  4: { x:-1, y: 0, z: 0 }, // west
  5: { x: 1, y: 0, z: 0 }, // east
};
const DROPPER_SCAN_RADIUS = 5;
function getFacingValue(block) {
  if (!block) return undefined;
  const perm = block.permutation;
  if (!perm) return undefined;
  let value = perm.getState("facing_direction");
  if (typeof value === "number") return value;
  value = perm.getState("minecraft:facing_direction");
  return typeof value === "number" ? value : undefined;
}
function purgeBundleFromDroppers(block1, block2, player, dim) {
  let removed = false;
  for (const b of [block1, block2]) {
    const invComp = b.getComponent("minecraft:inventory");
    if (!invComp) continue;
    const cont = invComp.container;
    for (let slot = 0; slot < cont.size; slot++) {
      const stack = cont.getItem(slot);
      if (stack && BUNDLE_TYPES.has(stack.typeId)) {
        cont.setItem(slot, undefined);
        removed = true;
      }
    }
  }
  if (removed) {
    dim.runCommand(
      `tellraw @a {"rawtext":[{"text":"§c<Anti-Dupe> §fRemoved §7Bundles§f From Facing Droppers Near §b${player.nameTag}§f!"}]}`
    );
    const pos = block1.location;
    const locStr = `${pos.x}, ${pos.y}, ${pos.z}`;
    addDupeLog(`Anti-Dupe: Removed bundles from facing droppers near ${player.nameTag} at ${locStr}.`);
    sendAdminAlert(`§c<Anti-Dupe> §7Removed Bundles From Facing Droppers Near §f${player.nameTag} §7at §e${locStr}§7.`);
  }
}

/**
 * Main loop: every 10 ticks (~½s) scans around each player for dupe attempts.
 */
system.runInterval(() => {
  for (const player of world.getAllPlayers()) {
    const dim = player.dimension;
    const { x: cx, y: cy, z: cz } = player.location;
    const baseX = Math.floor(cx);
    const baseY = Math.floor(cy);
    const baseZ = Math.floor(cz);

    // 2-high plant scanner
    if (!player.hasTag(DISABLE_PLANT_TAG)) {
      for (let dx = -10; dx <= 10; dx++) {
        for (let dy = -10; dy <= 10; dy++) {
          for (let dz = -10; dz <= 10; dz++) {
            const b = dim.getBlock({ x: baseX + dx, y: baseY + dy, z: baseZ + dz });
            if (b && TWO_HIGH.has(b.typeId)) purgePistons(player, dim, b);
          }
        }
      }
    }

    // Hopper scanner
    if (!player.hasTag(DISABLE_HOPPER_TAG)) {
      for (let dx = -HOPPER_SCAN_RADIUS; dx <= HOPPER_SCAN_RADIUS; dx++) {
        for (let dy = -HOPPER_SCAN_RADIUS; dy <= HOPPER_SCAN_RADIUS; dy++) {
          for (let dz = -HOPPER_SCAN_RADIUS; dz <= HOPPER_SCAN_RADIUS; dz++) {
            const pos   = { x: baseX + dx, y: baseY + dy, z: baseZ + dz };
            const block = dim.getBlock(pos);
            if (!block || block.typeId !== "minecraft:hopper") continue;
            const invComp = block.getComponent("minecraft:inventory");
            if (!invComp) continue;
            const cont = invComp.container;
            for (let slot = 0; slot < cont.size; slot++) {
              const stack = cont.getItem(slot);
              if (stack && BUNDLE_TYPES.has(stack.typeId)) {
                cont.setItem(slot, undefined);
                dim.runCommand(
                  `tellraw @a {"rawtext":[{"text":"§c<Anti-Dupe> §fRemoved §7${stack.typeId}§f From A Nearby Hopper Feeding Off §b${player.nameTag}§f!"}]}`
                );
                const locStr = `${pos.x}, ${pos.y}, ${pos.z}`;
                addDupeLog(`Anti-Dupe: Removed ${stack.typeId} from hopper near ${player.nameTag} at ${locStr}.`);
                sendAdminAlert(`§c<Anti-Dupe> §7Removed §f${stack.typeId} §7From Hopper Near §f${player.nameTag} §7at §e${locStr}§7.`);
              }
            }
          }
        }
      }
    }

    // Dropper pair scanner
    if (!player.hasTag(DISABLE_DROPPER_TAG)) {
      const processedPairs = new Set();
      for (let dx = -DROPPER_SCAN_RADIUS; dx <= DROPPER_SCAN_RADIUS; dx++) {
        for (let dy = -DROPPER_SCAN_RADIUS; dy <= DROPPER_SCAN_RADIUS; dy++) {
          for (let dz = -DROPPER_SCAN_RADIUS; dz <= DROPPER_SCAN_RADIUS; dz++) {
            const pos   = { x: baseX + dx, y: baseY + dy, z: baseZ + dz };
            const block = dim.getBlock(pos);
            if (!block || block.typeId !== "minecraft:dropper") continue;
            const facing = getFacingValue(block);
            if (facing === undefined) continue;
            const vec = FACING_VECTORS[facing];
            if (!vec) continue;
            const neighbourPos = { x: pos.x + vec.x, y: pos.y + vec.y, z: pos.z + vec.z };
            const neighbour    = dim.getBlock(neighbourPos);
            if (!neighbour || neighbour.typeId !== "minecraft:dropper") continue;
            const nFacing = getFacingValue(neighbour);
            if (nFacing === undefined) continue;
            const nVec    = FACING_VECTORS[nFacing];
            if (!nVec) continue;
            if (nVec.x === -vec.x && nVec.y === -vec.y && nVec.z === -vec.z) {
              const pairKey = `${Math.min(pos.x, neighbourPos.x)},${Math.min(pos.y, neighbourPos.y)},${Math.min(pos.z, neighbourPos.z)}|${Math.max(pos.x, neighbourPos.x)},${Math.max(pos.y, neighbourPos.y)},${Math.max(pos.z, neighbourPos.z)}`;
              if (processedPairs.has(pairKey)) continue;
              processedPairs.add(pairKey);
              purgeBundleFromDroppers(block, neighbour, player, dim);
            }
          }
        }
      }
    }
  }
}, 10);

/**
 * 5) ADMIN SETTINGS OR LOGS MENU
 *
 * Admins can open a small menu by right‑clicking (using) the bedrock item.  This menu
 * presents two buttons: one to configure patches and another to view dupe logs.
 * Both forms are scheduled via system.run() so they run with full privileges.
 */
world.beforeEvents.itemUse.subscribe((event) => {
  const { source, itemStack } = event;
  if (!source || !source.hasTag || !source.hasTag(ADMIN_TAG)) return;
  if (!itemStack || itemStack.typeId !== SETTINGS_ITEM) return;
  event.cancel = true;
  system.run(() => {
    const menu = new ActionFormData()
      .title("Anti-Dupe Menu")
      .body("Select An Option")
      .button("Configure Patches")
      .button("View Dupe Logs");
    ForceOpen(source, menu).then((res) => {
      if (!res || res.canceled) return;
      if (res.selection === 0) {
        openSettingsForm(source);
      } else if (res.selection === 1) {
        openDupeLogsMenu(source);
      }
    }).catch((err) => {
      console.warn(`Anti-Dupe menu error: ${err}`);
    });
  });
});

/**
 * 6) ADMIN LOGS MENU (fallback)
 *
 * You can still punch a block with bedrock to open the log viewer, but the new
 * settings menu button is the recommended method. This remains as a fallback.
 */
world.afterEvents.entityHitBlock.subscribe((event) => {
  const { damagingEntity } = event;
  if (!damagingEntity || damagingEntity.typeId !== "minecraft:player") return;
  const player = damagingEntity;
  if (!player.hasTag || !player.hasTag(ADMIN_TAG)) return;
  const invComp = player.getComponent("inventory");
  if (!invComp) return;
  const cont = invComp.container;
  const slot = typeof player.selectedSlot === "number" ? player.selectedSlot : 0;
  const heldItem = cont.getItem(slot);
  if (!heldItem || heldItem.typeId !== SETTINGS_ITEM) return;
  openDupeLogsMenu(player);
});
