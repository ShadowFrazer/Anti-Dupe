// Anti-Dupe

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

// --- PERSISTED LOG CONFIG (World Dynamic Property) ---
const DUPE_LOGS_KEY = "antidupe:logs";
// Conservative size cap to avoid dynamic property size/version edge cases.
// We always trim old entries until serialized JSON fits.
const DUPE_LOGS_MAX_CHARS = 12000;

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

// -----------------------------
// Helpers (compat + safety)
// -----------------------------
function getPlayersSafe() {
  try {
    if (typeof world.getAllPlayers === "function") return world.getAllPlayers();
    if (typeof world.getPlayers === "function") return world.getPlayers();
  } catch {}
  return [];
}

function runLater(fn, ticks = 0) {
  try {
    if (typeof system.runTimeout === "function") return system.runTimeout(fn, ticks);
  } catch {}
  // Fallback: immediate next tick at best
  try { return system.run(fn); } catch {}
}

function getEntityInventoryContainer(entity) {
  try {
    const inv =
      entity?.getComponent?.("minecraft:inventory") ??
      entity?.getComponent?.("inventory");
    return inv?.container ?? undefined;
  } catch {
    return undefined;
  }
}

function getCursorInventory(entity) {
  try {
    return (
      entity?.getComponent?.("minecraft:cursor_inventory") ??
      entity?.getComponent?.("cursor_inventory")
    );
  } catch {
    return undefined;
  }
}

function clearContainerSlot(container, slot) {
  try { container.setItem(slot, undefined); return; } catch {}
  try { container.setItem(slot, null); return; } catch {}
}

function setBlockToAir(block) {
  // Prefer fast API call if present
  try {
    if (typeof block.setType === "function") {
      block.setType("minecraft:air");
      return true;
    }
  } catch {}

  // Command fallback (slower, but keeps patch working across API differences)
  try {
    const dim = block.dimension;
    const l = block.location;
    const x = Math.floor(l.x), y = Math.floor(l.y), z = Math.floor(l.z);
    if (typeof dim.runCommandAsync === "function") {
      dim.runCommandAsync(`setblock ${x} ${y} ${z} air`);
      return true;
    }
    if (typeof dim.runCommand === "function") {
      dim.runCommand(`setblock ${x} ${y} ${z} air`);
      return true;
    }
  } catch {}

  return false;
}

// --- SAFE SLOT GETTER (prevents "Expected type: number") ---
function getSelectedSlotSafe(player, containerSize) {
  const raw = player?.selectedSlot;
  let slot = (typeof raw === "number" && Number.isFinite(raw)) ? raw : 0;
  if (typeof containerSize === "number" && containerSize > 0) {
    if (slot < 0) slot = 0;
    if (slot >= containerSize) slot = containerSize - 1;
  }
  return slot;
}

// -----------------------------
// Persistent Dupe Logs (Option A)
// -----------------------------
let dupeLogs = [];
let logsLoaded = false;
let logsDirty = false;
let saveQueued = false;

const persistenceEnabled =
  typeof world.getDynamicProperty === "function" &&
  typeof world.setDynamicProperty === "function";

function safeStringifyLogs(arr) {
  // Trim oldest until JSON fits.
  while (true) {
    let raw;
    try { raw = JSON.stringify(arr); } catch { raw = "[]"; }
    if (raw.length <= DUPE_LOGS_MAX_CHARS) return raw;
    if (arr.length === 0) return "[]";
    arr.shift();
  }
}

function loadLogs() {
  if (logsLoaded) return;
  logsLoaded = true;

  if (!persistenceEnabled) {
    // No persistence available in this runtime — keep memory-only logs.
    dupeLogs = [];
    return;
  }

  try {
    const raw = world.getDynamicProperty(DUPE_LOGS_KEY);
    if (typeof raw !== "string" || raw.length === 0) {
      dupeLogs = [];
      return;
    }
    const parsed = JSON.parse(raw);
    dupeLogs = Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    console.warn(`[Anti-Dupe] Failed to load logs: ${e}`);
    dupeLogs = [];
  }
}

function saveLogsNow() {
  if (!persistenceEnabled) return;
  if (!logsDirty) return;

  try {
    const raw = safeStringifyLogs(dupeLogs);
    world.setDynamicProperty(DUPE_LOGS_KEY, raw);
    logsDirty = false;
  } catch (e) {
    console.warn(`[Anti-Dupe] Failed to save logs: ${e}`);
  }
}

function queueSaveLogs() {
  logsDirty = true;
  if (!persistenceEnabled) return;
  if (saveQueued) return;

  saveQueued = true;
  runLater(() => {
    saveQueued = false;
    saveLogsNow();
  }, 40); // ~2 seconds (debounce)
}

function addDupeLog(entry) {
  dupeLogs.push(entry);
  if (dupeLogs.length > 100) dupeLogs.shift();
  queueSaveLogs();
}

// Load logs as early as possible (next tick), and also on worldInitialize if present.
runLater(loadLogs, 1);
try {
  world.afterEvents?.worldInitialize?.subscribe?.(() => runLater(loadLogs, 1));
} catch {}

// Periodic flush in case the server closes before debounce fires
system.runInterval(() => {
  try { saveLogsNow(); } catch {}
}, 200); // every 10 seconds

// -----------------------------
// Nearby players helper (used in alerts)
// -----------------------------
function getNearbyPlayers(offender, loc, radius = 50, cap = 12) {
  const players = getPlayersSafe();
  const nearby = [];
  const r2 = radius * radius;

  const ox = loc.x, oy = loc.y, oz = loc.z;

  for (const p of players) {
    if (!p || p === offender) continue;
    const pl = p.location;
    if (!pl) continue;

    const dx = pl.x - ox;
    const dy = pl.y - oy;
    const dz = pl.z - oz;

    if (dx * dx + dy * dy + dz * dz <= r2) {
      nearby.push(p.nameTag ?? p.name ?? "Player");
      if (nearby.length >= cap) break;
    }
  }
  return nearby;
}

// -----------------------------
// Alerts
// -----------------------------
function sendAdminAlert(message) {
  const admins = getPlayersSafe().filter((p) => p?.hasTag?.(ADMIN_TAG));
  for (const admin of admins) {
    if (admin.hasTag?.(DISABLE_ADMIN_MSG_TAG) || admin.hasTag?.(DISABLE_ALERT_TAG)) continue;
    try { admin.sendMessage(message); } catch {}
  }
}

function alertDupe(offender, dupeType, itemDesc, loc) {
  // Hardening: alerts must never crash scanner
  try {
    if (!offender || !loc) return;

    const coordStr = `${Math.floor(loc.x)}, ${Math.floor(loc.y)}, ${Math.floor(loc.z)}`;
    const nearby   = getNearbyPlayers(offender, loc, 50, 12);
    const nearList = nearby.length > 0 ? nearby.join(", ") : "None";

    const name = offender.nameTag ?? offender.name ?? "Unknown";
    const broadcastMsg = `§c<Anti-Dupe> §f§l${name}§r §7attempted a ${dupeType} with §f${itemDesc}§r.`;
    const adminMsg = `§c<Anti-Dupe> §6Admin Alert: §f§l${name}§r §7attempted a ${dupeType} with §f${itemDesc}§r at §e§l${coordStr}§r.\n§7Nearby: §e${nearList}§r.`;

    // Timestamp without depending on locale formatting
    const stamp = new Date().toISOString();
    addDupeLog(`${stamp} | ${name} | ${dupeType} | ${itemDesc} | ${coordStr} | nearby: ${nearList}`);

    for (const p of getPlayersSafe()) {
      if (!p?.hasTag?.(DISABLE_PUBLIC_MSG_TAG)) {
        try { p.sendMessage(broadcastMsg); } catch {}
      }
    }
    sendAdminAlert(adminMsg);
  } catch (e) {
    console.warn(`[Anti-Dupe] alertDupe failed: ${e}`);
  }
}

// -----------------------------
// Ghost Stack Patch
// -----------------------------
world.afterEvents.playerSpawn.subscribe(({ player, initialSpawn }) => {
  try {
    if (!initialSpawn || !player) return;
    if (player.hasTag?.(DISABLE_GHOST_TAG)) return;

    const cursor = getCursorInventory(player);
    const invCont = getEntityInventoryContainer(player);
    if (!cursor || !invCont) return;

    const held = cursor.item;
    const empty = invCont.emptySlotsCount;

    if (held && held.amount === held.maxAmount && empty === 0) {
      player.dimension.spawnItem(new ItemStack(held.typeId, 1), player.location);
      try { cursor.clear(); } catch {}
      alertDupe(player, "Ghost Stack Dupe", `${held.amount}x ${held.typeId}`, player.location);
    }
  } catch (e) {
    console.warn(`[Anti-Dupe] Ghost patch error: ${e}`);
  }
});

// -----------------------------
// Optimised Scanner (Generator)
// -----------------------------
function* mainScanner() {
  while (true) {
    const players = getPlayersSafe();

    for (const player of players) {
      try {
        if (!player?.location) continue;

        const dim = player.dimension;
        const { x: cx, y: cy, z: cz } = player.location;
        const bx = Math.floor(cx);
        const by = Math.floor(cy);
        const bz = Math.floor(cz);

        const checkPlant   = !player.hasTag?.(DISABLE_PLANT_TAG);
        const checkHopper  = !player.hasTag?.(DISABLE_HOPPER_TAG);
        const checkDropper = !player.hasTag?.(DISABLE_DROPPER_TAG);
        if (!checkPlant && !checkHopper && !checkDropper) continue;

        for (let dx = -SCAN_RADIUS; dx <= SCAN_RADIUS; dx++) {
          for (let dy = -SCAN_RADIUS; dy <= SCAN_RADIUS; dy++) {
            for (let dz = -SCAN_RADIUS; dz <= SCAN_RADIUS; dz++) {
              const pos = { x: bx + dx, y: by + dy, z: bz + dz };
              const block = dim.getBlock(pos);

              if (block) {
                const typeId = block.typeId;

                if (checkPlant && TWO_HIGH.has(typeId)) {
                  processPlantCheck(player, dim, block, pos);
                } else if (checkHopper && typeId === "minecraft:hopper") {
                  processHopperCheck(player, block, pos);
                } else if (checkDropper && typeId === "minecraft:dropper") {
                  processDropperCheck(player, dim, block, pos);
                }
              }

              yield;
            }
          }
        }
      } catch (e) {
        console.warn(`[ERROR] Scanner crashed on player: ${e}`);
      }
    }
    yield "FRAME_END";
  }
}

const scanner = mainScanner();

system.runInterval(() => {
  let ops = 0;
  let result;

  while (ops < BLOCKS_PER_TICK_LIMIT) {
    result = scanner.next();
    ops++;
    if (result?.value === "FRAME_END") break;
  }
}, 1);

// -----------------------------
// Patch Handlers
// -----------------------------
function processPlantCheck(player, dim, plantBlock, pos) {
  for (const o of PISTON_OFFSETS) {
    for (const d of [1, 2]) {
      const bx = pos.x + o.x * d;
      const bz = pos.z + o.z * d;
      const nb = dim.getBlock({ x: bx, y: pos.y, z: bz });
      if (!nb) continue;

      const t = nb.typeId;
      if (t === "minecraft:piston" || t === "minecraft:sticky_piston") {
        const ok = setBlockToAir(nb);
        if (ok) {
          console.warn(`[ACTION] Removed Piston at ${Math.floor(bx)}, ${Math.floor(pos.y)}, ${Math.floor(bz)}`);
          alertDupe(player, "Plant Dupe", plantBlock.typeId, pos);
        }
      }
    }
  }
}

function processHopperCheck(player, block, pos) {
  const inv =
    block.getComponent?.("minecraft:inventory") ??
    block.getComponent?.("inventory");
  const cont = inv?.container;
  if (!cont) return;

  let wiped = false;
  for (let slot = 0; slot < cont.size; slot++) {
    const stack = cont.getItem(slot);
    if (!stack) continue;

    if (BUNDLE_TYPES.has(stack.typeId)) {
      clearContainerSlot(cont, slot);
      wiped = true;
    }
  }

  if (wiped) alertDupe(player, "Hopper Bundle Dupe", "Bundle", pos);
}

function processDropperCheck(player, dim, block, pos) {
  const inv =
    block.getComponent?.("minecraft:inventory") ??
    block.getComponent?.("inventory");
  const cont = inv?.container;
  if (!cont) return;

  let wiped = false;
  for (let slot = 0; slot < cont.size; slot++) {
    const stack = cont.getItem(slot);
    if (!stack) continue;

    if (BUNDLE_TYPES.has(stack.typeId)) {
      // Eject the restricted item and wipe it from the container
      try {
        dim.spawnItem(stack, { x: pos.x + 0.5, y: pos.y + 1.2, z: pos.z + 0.5 });
      } catch {}
      clearContainerSlot(cont, slot);
      wiped = true;
    }
  }

  if (wiped) alertDupe(player, "Restricted Item (Ejected)", "Bundle", pos);
}

// -----------------------------
// UI Handling
// -----------------------------
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
      queueSaveLogs();
      try { player.sendMessage("§aLogs Cleared."); } catch {}
    }
  });
}

function openSettingsForm(player) {
  // IMPORTANT: Use options objects with defaultValue (prevents native type conversion errors)
  const form = new ModalFormData()
    .title("Anti-Dupe Config")
    .toggle("Ghost Stack Patch",    { defaultValue: !player.hasTag?.(DISABLE_GHOST_TAG) })
    .toggle("Plant Dupe Patch",     { defaultValue: !player.hasTag?.(DISABLE_PLANT_TAG) })
    .toggle("Hopper Bundle Patch",  { defaultValue: !player.hasTag?.(DISABLE_HOPPER_TAG) })
    .toggle("Dropper Bundle Patch", { defaultValue: !player.hasTag?.(DISABLE_DROPPER_TAG) })
    .toggle("Coordinate Alerts",    { defaultValue: !player.hasTag?.(DISABLE_ALERT_TAG) })
    .toggle("Public Messages",      { defaultValue: !player.hasTag?.(DISABLE_PUBLIC_MSG_TAG) })
    .toggle("Admin Messages",       { defaultValue: !player.hasTag?.(DISABLE_ADMIN_MSG_TAG) });

  ForceOpen(player, form).then((response) => {
    if (!response || response.canceled) return;

    const tags = [
      DISABLE_GHOST_TAG, DISABLE_PLANT_TAG, DISABLE_HOPPER_TAG, DISABLE_DROPPER_TAG,
      DISABLE_ALERT_TAG, DISABLE_PUBLIC_MSG_TAG, DISABLE_ADMIN_MSG_TAG
    ];

    response.formValues.forEach((enabled, i) => {
      const tag = tags[i];
      if (!tag) return;

      if (enabled) {
        if (player.hasTag?.(tag)) player.removeTag(tag);
      } else {
        if (!player.hasTag?.(tag)) player.addTag(tag);
      }
    });

    try { player.sendMessage("§aSettings Updated."); } catch {}
  });
}

// Menu Activation (Admin holds SETTINGS_ITEM)
world.beforeEvents.itemUse.subscribe((event) => {
  const source = event.source;
  const itemStack = event.itemStack;

  if (!source?.hasTag?.(ADMIN_TAG)) return;
  if (!itemStack || itemStack.typeId !== SETTINGS_ITEM) return;

  event.cancel = true;

  system.run(() => {
    const menu = new ActionFormData()
      .title("Anti-Dupe")
      .button("Settings")
      .button("Logs");

    ForceOpen(source, menu).then((res) => {
      if (!res || res.canceled) return;
      res.selection === 0 ? openSettingsForm(source) : openDupeLogsMenu(source);
    });
  });
});

// Optional log viewer via block hit (mining triggers this too — safe guarded)
world.afterEvents.entityHitBlock.subscribe((event) => {
  const p = event.damagingEntity;
  if (!p || p.typeId !== "minecraft:player") return;
  if (!p.hasTag?.(ADMIN_TAG)) return;

  const cont = getEntityInventoryContainer(p);
  if (!cont || cont.size <= 0) return;

  const slot = getSelectedSlotSafe(p, cont.size);
  const item = cont.getItem(slot);

  if (item?.typeId === SETTINGS_ITEM) openDupeLogsMenu(p);
});
