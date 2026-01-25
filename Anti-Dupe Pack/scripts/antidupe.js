import { world, system, ItemStack } from "@minecraft/server";
import { ModalFormData, MessageFormData, ActionFormData } from "@minecraft/server-ui";

/**
 * 1) GHOST‐STACK DETECTION
 */
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
    const ghostItemDesc = `${held.amount}x ${held.typeId}`;
    alertDupe(player, "Ghost Stack Dupe", ghostItemDesc, player.location);
  }
});

/**
 * 2) PLANT‐DUPE CUTTER
 */
const TWO_HIGH = new Set([
  "minecraft:tall_grass",
  "minecraft:tall_dry_grass",
  "minecraft:large_fern",
  "minecraft:sunflower",
  "minecraft:rose_bush",
  "minecraft:peony",
  "minecraft:lilac",
  "minecraft:cornflower",
  "minecraft:tall_seagrass",
  "minecraft:torchflower_crop",
  "minecraft:torchflower",
]);
const OFFSETS = [
  { x:  1, z:  0 }, { x: -1, z:  0 }, { x:  0, z:  1 }, { x:  0, z: -1 },
  { x:  1, z:  1 }, { x: -1, z:  1 }, { x:  1, z: -1 }, { x: -1, z: -1 },
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
        alertDupe(player, "Plant Dupe", plantBlock.typeId, { x: px, y: py, z: pz });
      }
    }
  }
}

/**
 * 3) HOPPER‐BUNDLE PURGE
 */
const BUNDLE_TYPES = new Set([
  "minecraft:bundle",
  "minecraft:red_bundle",
  "minecraft:blue_bundle",
  "minecraft:black_bundle",
  "minecraft:cyan_bundle",
  "minecraft:brown_bundle",
  "minecraft:gray_bundle",
  "minecraft:green_bundle",
  "minecraft:lime_bundle",
  "minecraft:light_blue_bundle",
  "minecraft:light_gray_bundle",
  "minecraft:magenta_bundle",
  "minecraft:orange_bundle",
  "minecraft:purple_bundle",
  "minecraft:white_bundle",
  "minecraft:yellow_bundle",
  "minecraft:pink_bundle",
]);
const HOPPER_SCAN_RADIUS = 5;

// Admin and messaging configuration
const ADMIN_TAG            = "Admin";
const SETTINGS_ITEM        = "minecraft:bedrock";
const DISABLE_GHOST_TAG    = "antidupe:disable_ghost";
const DISABLE_PLANT_TAG    = "antidupe:disable_plant";
const DISABLE_HOPPER_TAG   = "antidupe:disable_hopper";
const DISABLE_DROPPER_TAG  = "antidupe:disable_dropper";
const DISABLE_ALERT_TAG    = "antidupe:disable_alert";
const DISABLE_PUBLIC_MSG_TAG = "antidupe:disable_public_msg";
const DISABLE_ADMIN_MSG_TAG  = "antidupe:disable_admin_msg";

// Dupe log storage
let dupeLogs = [];
function addDupeLog(entry) {
  dupeLogs.push(entry);
  if (dupeLogs.length > 100) dupeLogs.shift();
}

function sendAdminAlert(message) {
  const admins = world.getPlayers
    ? world.getPlayers({ tags: [ADMIN_TAG] })
    : world.getAllPlayers().filter((p) => p.hasTag && p.hasTag(ADMIN_TAG));
  for (const admin of admins) {
    // Skip if admin has turned off admin messages or coordinate alerts
    if (admin.hasTag && (admin.hasTag(DISABLE_ADMIN_MSG_TAG) || admin.hasTag(DISABLE_ALERT_TAG))) continue;
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

function getNearbyPlayers(offender, loc, radius = 100) {
  const players = world.getPlayers ? world.getPlayers() : world.getAllPlayers();
  const nearby = [];
  for (const p of players) {
    if (!p || p === offender) continue;
    if (!p.location || !p.nameTag) continue;
    const dx = p.location.x - loc.x;
    const dy = p.location.y - loc.y;
    const dz = p.location.z - loc.z;
    const distSq = dx * dx + dy * dy + dz * dz;
    if (distSq <= radius * radius) {
      nearby.push(p.nameTag);
    }
  }
  return nearby;
}

/**
 * Unified alert routine for dupe attempts. Sends a broadcast message to all players
 * (respecting their public message toggle), then sends a detailed admin message
 * (respecting admin toggles) and records the event in the dupe log.
 *
 * @param {import("@minecraft/server").Player} offender
 * @param {string} dupeType
 * @param {string} itemDesc
 * @param {import("@minecraft/server").Vector3} loc
 */
function alertDupe(offender, dupeType, itemDesc, loc) {
  const coordStr = `${Math.floor(loc.x)}, ${Math.floor(loc.y)}, ${Math.floor(loc.z)}`;
  const nearby   = getNearbyPlayers(offender, loc, 100);
  const nearList = nearby.length > 0 ? nearby.join(", ") : "None";
  // Bold offender name and reset formatting for readability. Items are colored but not bold.
  const broadcastMsg = `§c<Anti-Dupe> §f§l${offender.nameTag}§r §7attempted a ${dupeType} with §f${itemDesc}§r.`;
  // For admins: bold offender name and coordinates. “Nearby Players” on a new line.
  const adminMsg = `§c<Anti-Dupe> §6Admin Alert: §f§l${offender.nameTag}§r §7attempted a ${dupeType} with §f${itemDesc}§r at §e§l${coordStr}§r.\n§7Nearby Players: §e${nearList}§r.`;
  addDupeLog(`Anti-Dupe: ${offender.nameTag} attempted a ${dupeType} with ${itemDesc} at ${coordStr}. Nearby players: ${nearList}.`);
  // Send broadcast to players individually, skipping those who disabled public messages
  const players = world.getPlayers ? world.getPlayers() : world.getAllPlayers();
  for (const p of players) {
    if (p.hasTag && p.hasTag(DISABLE_PUBLIC_MSG_TAG)) continue;
    try {
      p.sendMessage(broadcastMsg);
    } catch {
      const safe = broadcastMsg.replace(/"/g, '\\"');
      try {
        p.runCommand(`tellraw @s {"rawtext":[{"text":"${safe}"}]}`);
      } catch {}
    }
  }
  // Send admin alert
  sendAdminAlert(adminMsg);
}

/**
 * Helper to show forms reliably even if the player is busy.
 */
async function ForceOpen(player, form, timeout = 1200) {
  const start = system.currentTick;
  while (system.currentTick - start < timeout) {
    const response = await form.show(player);
    if (response.cancelationReason !== "UserBusy") return response;
  }
  return undefined;
}

/**
 * Show the dupe logs to an admin; allow clearing the log.
 */
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
    ForceOpen(player, form).then((res) => {
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
 * Show the settings form for an admin.  The form includes toggles for each
 * anti‑dupe patch, coordinate alerts, and new toggles for public and admin messages.
 */
function openSettingsForm(player) {
  const form = new ModalFormData()
    .title("Anti-Dupe Configuration")
    .toggle("Ghost Stack Patch",   { defaultValue: !player.hasTag(DISABLE_GHOST_TAG) })
    .toggle("Plant Dupe Patch",    { defaultValue: !player.hasTag(DISABLE_PLANT_TAG) })
    .toggle("Hopper Bundle Patch", { defaultValue: !player.hasTag(DISABLE_HOPPER_TAG) })
    .toggle("Dropper Pair Patch",  { defaultValue: !player.hasTag(DISABLE_DROPPER_TAG) })
    .toggle("Coordinate Alerts",   { defaultValue: !player.hasTag(DISABLE_ALERT_TAG) })
    .toggle("Public Messages",     { defaultValue: !player.hasTag(DISABLE_PUBLIC_MSG_TAG) })
    .toggle("Admin Messages",      { defaultValue: !player.hasTag(DISABLE_ADMIN_MSG_TAG) });
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
        { enabled: values[5], tag: DISABLE_PUBLIC_MSG_TAG },
        { enabled: values[6], tag: DISABLE_ADMIN_MSG_TAG },
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
          dim.runCommand(`tellraw @s {"rawtext":[{"text":"§aAnti-Dupe Settings Updated."}]}`);
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
  0: { x: 0, y:-1, z: 0 },
  1: { x: 0, y: 1, z: 0 },
  2: { x: 0, y: 0, z:-1 }, // north
  3: { x: 0, y: 0, z: 1 },  // south
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
  let removedCount = 0;
  for (const b of [block1, block2]) {
    const invComp = b.getComponent("minecraft:inventory");
    if (!invComp) continue;
    const cont = invComp.container;
    for (let slot = 0; slot < cont.size; slot++) {
      const stack = cont.getItem(slot);
      if (!stack) continue;
      if (BUNDLE_TYPES.has(stack.typeId)) {
        removedCount += stack.amount;
        cont.setItem(slot, undefined);
      }
    }
  }
  if (removedCount > 0) {
    const pos = block1.location;
    const dropperItemDesc = `${removedCount}x bundle`;
    alertDupe(player, "Dropper Pair Dupe", dropperItemDesc, pos);
  }
}

/**
 * Main scanning loop: checks for dupe attempts every 10 ticks.
 */
system.runInterval(() => {
  for (const player of world.getAllPlayers()) {
    const dim   = player.dimension;
    const { x: cx, y: cy, z: cz } = player.location;
    const baseX = Math.floor(cx);
    const baseY = Math.floor(cy);
    const baseZ = Math.floor(cz);

    // Plant dupe scanning
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

    // Hopper scanning
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
              if (!stack) continue;
              if (BUNDLE_TYPES.has(stack.typeId)) {
                cont.setItem(slot, undefined);
                const hopperItemDesc = `${stack.amount}x ${stack.typeId}`;
                alertDupe(player, "Hopper Bundle Dupe", hopperItemDesc, pos);
              }
            }
          }
        }
      }
    }

    // Dropper pair scanning
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
            const vec    = FACING_VECTORS[facing];
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
 * Right‑clicking with bedrock opens a menu allowing the admin to configure patches
 * or view logs.  This menu uses ActionFormData for two buttons.
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
      if (res.selection === 0) openSettingsForm(source);
      else if (res.selection === 1) openDupeLogsMenu(source);
    }).catch((err) => {
      console.warn(`Anti-Dupe menu error: ${err}`);
    });
  });
});

/**
 * 6) ADMIN LOGS MENU (fallback)
 *
 * Admins may still punch a block with bedrock to open the log viewer.
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
