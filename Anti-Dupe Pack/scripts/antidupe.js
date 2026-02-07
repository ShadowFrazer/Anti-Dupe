// Anti-Dupe

import { world, system, ItemStack } from "@minecraft/server";
import { ModalFormData, MessageFormData, ActionFormData } from "@minecraft/server-ui";

const SCAN_RADIUS = 4;
const BLOCKS_PER_TICK_LIMIT = 2000;

// Illegal stack enforcement
const ILLEGAL_STACK_HARD_CAP = 64;   // hard cap
const ILLEGAL_STACK_SCAN_TICKS = 40; // run every 2s (reduce if you want)

// --- Tags ---
const ADMIN_TAG              = "Admin";
const SETTINGS_ITEM          = "minecraft:bedrock";

// Legacy per-admin patch toggles. Patch control now uses world configuration.
const DISABLE_GHOST_TAG      = "antidupe:disable_ghost";
const DISABLE_PLANT_TAG      = "antidupe:disable_plant";
const DISABLE_HOPPER_TAG     = "antidupe:disable_hopper";
const DISABLE_DROPPER_TAG    = "antidupe:disable_dropper";

// Personal (per-admin) messaging preferences
const DISABLE_ALERT_TAG      = "antidupe:disable_alert";
const DISABLE_PUBLIC_MSG_TAG = "antidupe:disable_public_msg";
const DISABLE_ADMIN_MSG_TAG  = "antidupe:disable_admin_msg";

// --- Log Storage (Dynamic Property) ---
const DUPE_LOGS_KEY = "antidupe:logs";
const DUPE_LOGS_MAX_CHARS = 12000;

// --- Global Configuration Storage ---
const GLOBAL_CONFIG_KEY = "antidupe:config";
const GLOBAL_CONFIG_MAX_CHARS = 2400;

// --- Restricted Items ---
const DEFAULT_RESTRICTED_ITEMS = [
  "minecraft:bundle", "minecraft:red_bundle", "minecraft:blue_bundle",
  "minecraft:black_bundle", "minecraft:cyan_bundle", "minecraft:brown_bundle",
  "minecraft:gray_bundle", "minecraft:green_bundle", "minecraft:lime_bundle",
  "minecraft:light_blue_bundle", "minecraft:light_gray_bundle",
  "minecraft:magenta_bundle", "minecraft:orange_bundle", "minecraft:purple_bundle",
  "minecraft:white_bundle", "minecraft:yellow_bundle", "minecraft:pink_bundle",
];

const MAX_RESTRICTED_ITEMS = 90; // prevents configuration overflow + UI spam

const DEFAULT_GLOBAL_CONFIG = {
  ghostPatch: true,
  plantPatch: true,
  hopperPatch: true,
  dropperPatch: true,
  illegalStackPatch: true,
  tracking: {
    enabled: true,
    updateIntervalSeconds: 10,
    trackAllPlayers: false,
  },
  restrictedItems: DEFAULT_RESTRICTED_ITEMS.slice(),
  punishments: {
    enabled: true,
    allowKick: false,
    bypassTag: "",
    punishmentTag: "",
    reasonTemplate: "Anti-Dupe: {TYPE} ({COUNT}/{THRESHOLD})",
    cooldownTicks: 20,
    publicKickMessage: true,
    types: {
      ghost:   { enabled: true,  threshold: 1, tag: "", kickAtThreshold: false, kickIfTaggedOnRepeat: false },
      plant:   { enabled: true,  threshold: 1, tag: "", kickAtThreshold: false, kickIfTaggedOnRepeat: false },
      hopper:  { enabled: true,  threshold: 3, tag: "", kickAtThreshold: false, kickIfTaggedOnRepeat: false },
      dropper: { enabled: true,  threshold: 3, tag: "", kickAtThreshold: false, kickIfTaggedOnRepeat: false },
      illegal: { enabled: true,  threshold: 1, tag: "", kickAtThreshold: false, kickIfTaggedOnRepeat: false },
      other:   { enabled: false, threshold: 0, tag: "", kickAtThreshold: false, kickIfTaggedOnRepeat: false },
    },
  },
};

// --- Violations ---
/**
 * Objective IDs are intentionally short for compatibility.
 * Display names provide the readable labels.
 */
const VIO_OBJ_TOTAL   = "ad_total";
const VIO_OBJ_GHOST   = "ad_ghost";
const VIO_OBJ_PLANT   = "ad_plant";
const VIO_OBJ_HOPPER  = "ad_hopper";
const VIO_OBJ_DROPPER = "ad_dropper";
const VIO_OBJ_ILLEGAL = "ad_illegal";
const VIO_OBJ_OTHER   = "ad_other";
const VIO_OBJ_GLOBAL  = "ad_global"; // fake participant "#global" holds global count

const GLOBAL_PARTICIPANT = "#global";

const VIO_STATS_KEY = "antidupe:vstats";
const VIO_STATS_MAX_CHARS = 4000;
const VIOLATIONS_DB_KEY = "violations_db";
const VIOLATIONS_DB_LEGACY_KEY = "violators_db";
const VIOLATIONS_DB_MAX_CHARS = 8000;
const VIOLATIONS_DB_SCHEMA = 2;

const DEFAULT_VIO_STATS = {
  globalCount: 0,
  mostRecent: { t: "", player: "", type: "" },
  typeCounts: { ghost: 0, plant: 0, hopper: 0, dropper: 0, illegal: 0, other: 0 },
};

// --- Sets and Data ---
const TWO_HIGH = new Set([
  "minecraft:tall_grass", "minecraft:tall_dry_grass", "minecraft:large_fern",
  "minecraft:sunflower", "minecraft:rose_bush", "minecraft:peony",
  "minecraft:lilac", "minecraft:cornflower", "minecraft:tall_seagrass",
  "minecraft:torchflower_crop", "minecraft:torchflower",
]);

const PISTON_OFFSETS = [
  { x:  1, z:  0 }, { x: -1, z:  0 }, { x:  0, z:  1 }, { x:  0, z: -1 },
  { x:  1, z:  1 }, { x: -1, z:  1 }, { x:  1, z: -1 }, { x: -1, z: -1 },
];

// --- Debug (Runtime Only) ---
const DEBUG_LOG_MAX = 250;
const DEBUG_CONSOLE = false;

let debugLog = []; // runtime only
let debugCounters = { info: 0, warn: 0, error: 0 };
let debugLastByKey = Object.create(null);

function dbgPush(level, area, message) {
  try {
    const lvl = String(level || "info").toLowerCase();
    const entry = {
      t: new Date().toISOString(),
      tick: system.currentTick,
      lvl,
      area: String(area || "core"),
      msg: String(message || ""),
    };

    debugLog.push(entry);
    if (debugLog.length > DEBUG_LOG_MAX) debugLog.shift();

    if (lvl === "error") debugCounters.error++;
    else if (lvl === "warn") debugCounters.warn++;
    else debugCounters.info++;
  } catch {
    // last resort: do nothing
  }
}

function dbgInfo(area, msg) { dbgPush("info", area, msg); }
function dbgWarn(area, msg) { dbgPush("warn", area, msg); }
function dbgError(area, msg) { dbgPush("error", area, msg); }

function logConsoleWarn(msg) { if (DEBUG_CONSOLE) console.warn(msg); }
function logConsoleInfo(msg) { if (DEBUG_CONSOLE) console.log(msg); }
function logConsoleError(msg) { console.error(msg); }

function dbgOncePer(key, minTicks, level, area, msg) {
  try {
    const now = system.currentTick;
    const last = debugLastByKey[key] ?? -99999999;
    if (now - last < minTicks) return;
    debugLastByKey[key] = now;
    dbgPush(level, area, msg);
  } catch {}
}

// --- Helpers ---
function getPlayersSafe() {
  try {
    if (typeof world.getAllPlayers === "function") return world.getAllPlayers();
    if (typeof world.getPlayers === "function") return world.getPlayers();
  } catch (e) {
    dbgError("players", `getPlayersSafe error: ${e}`);
  }
  return [];
}

function runLater(fn, ticks = 0) {
  try {
    if (typeof system.runTimeout === "function") return system.runTimeout(fn, ticks);
  } catch (e) {
    dbgWarn("scheduler", `runTimeout unavailable or failed: ${e}`);
  }
  try { return system.run(fn); } catch (e) {
    dbgError("scheduler", `system.run error: ${e}`);
  }
}

function openNextTick(fn) {
  runLater(() => {
    try { fn(); } catch (e) {
      dbgError("ui", `OpenNextTick error: ${e}`);
      console.warn(`[Anti-Dupe] OpenNextTick error: ${e}`);
    }
  }, 0);
}

function notifyFormFailed(player, context) {
  const msg = "§c[Anti-Dupe] Form failed to open. Check Debug > View Debug Log.";
  try { player?.sendMessage?.(msg); } catch {}
  const note = context ? ` (${context})` : "";
  console.warn(`[Anti-Dupe] Form failed to open${note}.`);
}

function getEntityInventoryContainer(entity) {
  try {
    const inv =
      entity?.getComponent?.("minecraft:inventory") ??
      entity?.getComponent?.("inventory");
    return inv?.container ?? undefined;
  } catch (e) {
    dbgWarn("inventory", `getEntityInventoryContainer error: ${e}`);
    return undefined;
  }
}

function getCursorInventory(entity) {
  try {
    return (
      entity?.getComponent?.("minecraft:cursor_inventory") ??
      entity?.getComponent?.("cursor_inventory")
    );
  } catch (e) {
    dbgWarn("inventory", `getCursorInventory error: ${e}`);
    return undefined;
  }
}

function clearContainerSlot(container, slot) {
  try { container.setItem(slot, undefined); return; } catch {}
  try { container.setItem(slot, null); return; } catch {}
}

function setBlockToAir(block) {
  try {
    if (typeof block.setType === "function") {
      block.setType("minecraft:air");
      return true;
    }
  } catch (e) {
    dbgWarn("blocks", `block.setType error: ${e}`);
  }

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
  } catch (e) {
    dbgError("blocks", `setBlockToAir command fallback error: ${e}`);
  }

  return false;
}

function getSelectedSlotSafe(player, containerSize) {
  const raw = player?.selectedSlot;
  let slot = (typeof raw === "number" && Number.isFinite(raw)) ? raw : 0;
  if (typeof containerSize === "number" && containerSize > 0) {
    if (slot < 0) slot = 0;
    if (slot >= containerSize) slot = containerSize - 1;
  }
  return slot;
}

function safeStringifyWithCap(value, capChars, fallbackObj) {
  let raw;
  try { raw = JSON.stringify(value); } catch { raw = ""; }
  if (typeof raw !== "string") raw = "";
  if (raw.length <= capChars) return raw;
  try { return JSON.stringify(fallbackObj ?? {}); } catch { return "{}"; }
}

function clampInt(n, fallback = 0) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.floor(v);
}

function pad2(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return "00";
  return v < 10 ? `0${v}` : String(v);
}

function formatIsoUtcSplit(isoString) {
  const raw = String(isoString ?? "");
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) {
    return {
      date: "Unknown",
      time: raw || "Unknown",
      combined: raw || "Unknown",
    };
  }

  const year = d.getUTCFullYear();
  const month = pad2(d.getUTCMonth() + 1);
  const day = pad2(d.getUTCDate());
  const hour = pad2(d.getUTCHours());
  const minute = pad2(d.getUTCMinutes());
  const second = pad2(d.getUTCSeconds());

  const date = `${year}-${month}-${day}`;
  const time = `${hour}:${minute}:${second} UTC`;
  return { date, time, combined: `${date} | ${time}` };
}

// --- Dimension Helpers ---
function dimensionIdFromDimension(dim) {
  try {
    if (!dim) return "unknown";
    const id = dim?.id ?? dim?.dimensionId ?? dim?.type ?? dim?.name;
    if (typeof id === "string" && id.length) return id;

    // Fallback: compare known dimension objects
    try { if (dim === world.getDimension?.("overworld")) return "minecraft:overworld"; } catch {}
    try { if (dim === world.getDimension?.("nether")) return "minecraft:nether"; } catch {}
    try { if (dim === world.getDimension?.("the_end")) return "minecraft:the_end"; } catch {}

    return "unknown";
  } catch (e) {
    dbgWarn("dimension", `dimensionIdFromDimension error: ${e}`);
    return "unknown";
  }
}

function prettyDimension(id) {
  const s = String(id ?? "").toLowerCase();
  if (s.includes("overworld")) return "Overworld";
  if (s.includes("nether")) return "Nether";
  if (s.includes("the_end") || (s.includes("end") && !s.includes("vendor"))) return "The End";
  if (s && s !== "unknown") return s;
  return "Unknown";
}

function safeDimIdFromEntity(entity) {
  try {
    const dim = entity?.dimension;
    return dimensionIdFromDimension(dim);
  } catch (e) {
    dbgWarn("dimension", `safeDimIdFromEntity error: ${e}`);
    return "unknown";
  }
}

// --- Persistence ---
const persistenceEnabled =
  typeof world.getDynamicProperty === "function" &&
  typeof world.setDynamicProperty === "function";

dbgInfo("boot", `Persistence Enabled: ${persistenceEnabled ? "true" : "false"}`);

// --- Global Configuration ---
let globalConfig = { ...DEFAULT_GLOBAL_CONFIG };
let configLoaded = false;
let configDirty = false;
let configSaveQueued = false;

// Cached restricted item set for scans.
let restrictedItemsSet = new Set(DEFAULT_RESTRICTED_ITEMS);

function isValidNamespacedId(s) {
  const v = String(s ?? "").trim().toLowerCase();
  // simple + safe: namespace:item (letters, digits, _, -, .)
  return /^[a-z0-9_.-]+:[a-z0-9_.-]+$/.test(v);
}

function sanitizeRestrictedItems(arr) {
  const out = [];
  const seen = new Set();

  const src = Array.isArray(arr) ? arr : [];
  for (const raw of src) {
    const v = String(raw ?? "").trim().toLowerCase();
    if (!v) continue;
    if (!isValidNamespacedId(v)) continue;
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
    if (out.length >= MAX_RESTRICTED_ITEMS) break;
  }

  return out;
}

function clampRangeInt(value, min, max, fallback) {
  const v = clampInt(value, fallback);
  if (v < min) return min;
  if (v > max) return max;
  return v;
}

function normalizePunishmentType(input, defaults) {
  const out = { ...defaults };
  if (!input || typeof input !== "object") return out;

  if ("enabled" in input) out.enabled = !!input.enabled;
  if ("threshold" in input) out.threshold = clampRangeInt(input.threshold, 0, 200, defaults.threshold);
  if ("tag" in input) {
    const t = String(input.tag ?? "").trim();
    out.tag = t.length > 32 ? t.slice(0, 32) : t;
  }
  if ("kickAtThreshold" in input) out.kickAtThreshold = !!input.kickAtThreshold;
  if ("kickIfTaggedOnRepeat" in input) out.kickIfTaggedOnRepeat = !!input.kickIfTaggedOnRepeat;

  return out;
}

function normalizePunishments(input) {
  const defaults = DEFAULT_GLOBAL_CONFIG.punishments;
  const out = {
    enabled: defaults.enabled,
    allowKick: defaults.allowKick,
    bypassTag: defaults.bypassTag,
    punishmentTag: defaults.punishmentTag,
    reasonTemplate: defaults.reasonTemplate,
    cooldownTicks: defaults.cooldownTicks,
    publicKickMessage: defaults.publicKickMessage,
    types: {
      ghost:   { ...defaults.types.ghost },
      plant:   { ...defaults.types.plant },
      hopper:  { ...defaults.types.hopper },
      dropper: { ...defaults.types.dropper },
      illegal: { ...defaults.types.illegal },
      other:   { ...defaults.types.other },
    },
  };

  if (!input || typeof input !== "object") return out;

  if ("enabled" in input) out.enabled = !!input.enabled;
  if ("allowKick" in input) out.allowKick = !!input.allowKick;
  if ("publicKickMessage" in input) out.publicKickMessage = !!input.publicKickMessage;

  if ("bypassTag" in input) {
    const t = String(input.bypassTag ?? "").trim();
    out.bypassTag = t.length > 32 ? t.slice(0, 32) : t;
  }

  if ("punishmentTag" in input) {
    const t = String(input.punishmentTag ?? "").trim();
    out.punishmentTag = t.length > 32 ? t.slice(0, 32) : t;
  }

  if ("reasonTemplate" in input) {
    const t = String(input.reasonTemplate ?? "").trim();
    out.reasonTemplate = t.length > 120 ? t.slice(0, 120) : t;
  }

  if ("cooldownTicks" in input) {
    out.cooldownTicks = clampRangeInt(input.cooldownTicks, 0, 200, defaults.cooldownTicks);
  }

  const types = input.types && typeof input.types === "object" ? input.types : {};
  out.types.ghost = normalizePunishmentType(types.ghost, defaults.types.ghost);
  out.types.plant = normalizePunishmentType(types.plant, defaults.types.plant);
  out.types.hopper = normalizePunishmentType(types.hopper, defaults.types.hopper);
  out.types.dropper = normalizePunishmentType(types.dropper, defaults.types.dropper);
  out.types.illegal = normalizePunishmentType(types.illegal, defaults.types.illegal);
  out.types.other = normalizePunishmentType(types.other, defaults.types.other);

  return out;
}

function normalizeTracking(input) {
  const defaults = DEFAULT_GLOBAL_CONFIG.tracking;
  const out = {
    enabled: defaults.enabled,
    updateIntervalSeconds: defaults.updateIntervalSeconds,
    trackAllPlayers: defaults.trackAllPlayers,
  };

  if (!input || typeof input !== "object") return out;

  if ("enabled" in input) out.enabled = !!input.enabled;
  if ("updateIntervalSeconds" in input) {
    out.updateIntervalSeconds = clampRangeInt(
      input.updateIntervalSeconds,
      1,
      600,
      defaults.updateIntervalSeconds
    );
  }
  if ("trackAllPlayers" in input) out.trackAllPlayers = !!input.trackAllPlayers;

  return out;
}

function rebuildRestrictedItemsSet() {
  try {
    const list = Array.isArray(globalConfig.restrictedItems)
      ? globalConfig.restrictedItems
      : DEFAULT_RESTRICTED_ITEMS;

    restrictedItemsSet = new Set(list.map(v => String(v).toLowerCase()));
    dbgInfo("config", `Restricted items set rebuilt (count=${restrictedItemsSet.size}).`);
  } catch (e) {
    restrictedItemsSet = new Set(DEFAULT_RESTRICTED_ITEMS);
    dbgError("config", `Unable to rebuild restricted item set; reverted to defaults: ${e}`);
  }
}

function normalizeConfig(obj) {
  const cfg = { ...DEFAULT_GLOBAL_CONFIG };

  if (obj && typeof obj === "object") {
    if ("ghostPatch"         in obj) cfg.ghostPatch         = !!obj.ghostPatch;
    if ("plantPatch"         in obj) cfg.plantPatch         = !!obj.plantPatch;
    if ("hopperPatch"        in obj) cfg.hopperPatch        = !!obj.hopperPatch;
    if ("dropperPatch"       in obj) cfg.dropperPatch       = !!obj.dropperPatch;
    if ("illegalStackPatch"  in obj) cfg.illegalStackPatch  = !!obj.illegalStackPatch;
    if ("tracking"           in obj) cfg.tracking           = normalizeTracking(obj.tracking);
    else cfg.tracking = normalizeTracking(null);

    if ("restrictedItems" in obj) {
      const cleaned = sanitizeRestrictedItems(obj.restrictedItems);
      cfg.restrictedItems = cleaned.length ? cleaned : DEFAULT_RESTRICTED_ITEMS.slice();
    } else {
      cfg.restrictedItems = DEFAULT_RESTRICTED_ITEMS.slice();
    }

    if ("punishments" in obj) {
      cfg.punishments = normalizePunishments(obj.punishments);
    } else {
      cfg.punishments = normalizePunishments(null);
    }
  } else {
    cfg.punishments = normalizePunishments(null);
    cfg.tracking = normalizeTracking(null);
  }

  return cfg;
}

// Ensures configuration fits the size cap by trimming restrictedItems when needed.
function safeStringifyConfigWithCap(cfg) {
  const temp = normalizeConfig(cfg);
  let trimmed = 0;
  let templateTrimStage = 0;
  let tagsCleared = false;

  while (true) {
    let raw = "";
    try { raw = JSON.stringify(temp); } catch { raw = ""; }

    if (raw && raw.length <= GLOBAL_CONFIG_MAX_CHARS) {
      return { raw, trimmed };
    }

    // If too large, trim restrictedItems first
    if (Array.isArray(temp.restrictedItems) && temp.restrictedItems.length > 0) {
      temp.restrictedItems.pop();
      trimmed++;
      continue;
    }

    if (temp.punishments?.reasonTemplate && templateTrimStage < 2) {
      const limit = templateTrimStage === 0 ? 60 : 30;
      temp.punishments.reasonTemplate = temp.punishments.reasonTemplate.slice(0, limit);
      templateTrimStage++;
      continue;
    }

    if (!tagsCleared && temp.punishments?.types) {
      for (const k of Object.keys(temp.punishments.types)) {
        temp.punishments.types[k].tag = "";
      }
      if (temp.punishments.punishmentTag) temp.punishments.punishmentTag = "";
      tagsCleared = true;
      continue;
    }

    // Absolute last resort
    try {
      const def = normalizeConfig(DEFAULT_GLOBAL_CONFIG);
      return { raw: JSON.stringify(def), trimmed: -1 };
    } catch {
      return { raw: "{}", trimmed: -1 };
    }
  }
}

function loadGlobalConfig() {
  if (configLoaded) return;
  configLoaded = true;

  if (!persistenceEnabled) {
    globalConfig = { ...DEFAULT_GLOBAL_CONFIG };
    rebuildRestrictedItemsSet();
    dbgWarn("config", "Dynamic properties unavailable; using default configuration (not persistent).");
    return;
  }

  try {
    const raw = world.getDynamicProperty(GLOBAL_CONFIG_KEY);

    if (typeof raw !== "string" || raw.length === 0) {
      globalConfig = { ...DEFAULT_GLOBAL_CONFIG };
      rebuildRestrictedItemsSet();
      dbgInfo("config", "No saved configuration found; using defaults.");
      return;
    }

    globalConfig = normalizeConfig(JSON.parse(raw));
    rebuildRestrictedItemsSet();
    dbgInfo("config", "Loaded global configuration.");
  } catch (e) {
    console.warn(`[Anti-Dupe] Unable to load global configuration: ${e}`);
    dbgError("config", `Unable to load global configuration; reverted to defaults: ${e}`);
    globalConfig = { ...DEFAULT_GLOBAL_CONFIG };
    rebuildRestrictedItemsSet();
  }
}

function saveGlobalConfigNow() {
  if (!persistenceEnabled) return;
  if (!configDirty) return;

  try {
    const { raw, trimmed } = safeStringifyConfigWithCap(globalConfig);
    world.setDynamicProperty(GLOBAL_CONFIG_KEY, raw);
    configDirty = false;

    if (trimmed > 0) {
      dbgWarn("config", `Configuration exceeded size cap; trimmed restrictedItems by ${trimmed}.`);
      // also update in-memory to match what was saved
      try {
        globalConfig = normalizeConfig(JSON.parse(raw));
        rebuildRestrictedItemsSet();
      } catch {}
    } else if (trimmed === -1) {
      dbgError("config", "Configuration exceeded size cap and could not be trimmed; fallback configuration saved.");
    } else {
      dbgInfo("config", "Global configuration saved.");
    }
  } catch (e) {
    console.warn(`[Anti-Dupe] Unable to save global configuration: ${e}`);
    dbgError("config", `Unable to save global configuration: ${e}`);
  }
}

function queueSaveGlobalConfig() {
  configDirty = true;
  if (!persistenceEnabled) return;
  if (configSaveQueued) return;

  configSaveQueued = true;
  runLater(() => {
    configSaveQueued = false;
    saveGlobalConfigNow();
  }, 40);
}

runLater(loadGlobalConfig, 1);
try {
  world.afterEvents?.worldInitialize?.subscribe?.(() => runLater(loadGlobalConfig, 1));
} catch (e) {
  dbgWarn("config", `worldInitialize subscription failed: ${e}`);
}

system.runInterval(() => {
  try { saveGlobalConfigNow(); } catch {}
}, 200);

// --- Violations ---
let vioStats = { ...DEFAULT_VIO_STATS };
let vioStatsLoaded = false;
let vioStatsDirty = false;
let vioStatsSaveQueued = false;

let vioObjectivesReady = false;
let vioInitAttempted = false;

// --- Violations Registry ---
let violationsDb = { schema: VIOLATIONS_DB_SCHEMA, profiles: {} };
let violationsDbLoaded = false;
let violationsDbDirty = false;
let violationsDbSaveQueued = false;
let violationsDbLastTrackingMs = 0;

function emptyViolationsDb() {
  return { schema: VIOLATIONS_DB_SCHEMA, profiles: {} };
}

function normalizeViolationKey(name) {
  return String(name ?? "").trim().toLowerCase();
}

function normalizeLastKnown(input, fallbackCapturedMs = 0) {
  if (!input || typeof input !== "object") return null;
  const x = Number.isFinite(input.x) ? clampInt(input.x, 0) : null;
  const y = Number.isFinite(input.y) ? clampInt(input.y, 0) : null;
  const z = Number.isFinite(input.z) ? clampInt(input.z, 0) : null;
  const dim = typeof input.dim === "string"
    ? input.dim
    : (typeof input.dimension === "string" ? input.dimension : "unknown");
  const capturedMs = Number.isFinite(input.capturedMs) ? input.capturedMs : fallbackCapturedMs;
  if (x === null && y === null && z === null && (!dim || dim === "unknown") && !capturedMs) return null;
  return { x, y, z, dim: dim || "unknown", capturedMs: capturedMs || 0 };
}

function normalizeViolationProfile(raw, fallbackName) {
  const rec = raw && typeof raw === "object" ? raw : {};
  const nameRaw = typeof rec.name === "string" && rec.name.trim() ? rec.name : fallbackName;
  const name = nameRaw && String(nameRaw).trim() ? String(nameRaw).trim() : "Unknown";
  const kickLoop = rec.kickLoop && typeof rec.kickLoop === "object" ? rec.kickLoop : {};
  const legacyKnown = rec.lastKnownLocation && typeof rec.lastKnownLocation === "object"
    ? normalizeLastKnown(
      {
        x: rec.lastKnownLocation.x,
        y: rec.lastKnownLocation.y,
        z: rec.lastKnownLocation.z,
        dimension: rec.lastKnownLocation.dimension,
      },
      Number.isFinite(rec.lastKnownAt) ? rec.lastKnownAt : 0
    )
    : null;
  const lastKnown = normalizeLastKnown(rec.lastKnown, Number.isFinite(rec.lastKnownAt) ? rec.lastKnownAt : 0) || legacyKnown;

  return {
    name,
    violations: Number.isFinite(rec.violations) ? rec.violations : 0,
    lastViolationAt: Number.isFinite(rec.lastViolationAt) ? rec.lastViolationAt : 0,
    reason: typeof rec.reason === "string" ? rec.reason : "",
    kickLoop: {
      enabled: !!kickLoop.enabled,
      since: Number.isFinite(kickLoop.since) ? kickLoop.since : 0,
      lastKickAt: Number.isFinite(kickLoop.lastKickAt) ? kickLoop.lastKickAt : 0,
      intervalSec: Number.isFinite(kickLoop.intervalSec) ? kickLoop.intervalSec : 10,
    },
    lastSeenMs: Number.isFinite(rec.lastSeenMs) ? rec.lastSeenMs : 0,
    lastKnown,
    lastKnownSource: typeof rec.lastKnownSource === "string" ? rec.lastKnownSource : "",
  };
}

function violationProfileActivityMs(profile) {
  const lastSeen = Number.isFinite(profile?.lastSeenMs) ? profile.lastSeenMs : 0;
  const lastViolation = Number.isFinite(profile?.lastViolationAt) ? profile.lastViolationAt : 0;
  const lastKnown = Number.isFinite(profile?.lastKnown?.capturedMs) ? profile.lastKnown.capturedMs : 0;
  return Math.max(lastSeen, lastViolation, lastKnown);
}

function mergeViolationProfiles(current, incoming) {
  const a = current ?? normalizeViolationProfile({}, "");
  const b = incoming ?? normalizeViolationProfile({}, "");

  // Use the highest violation count to avoid inflating totals when deduplicating.
  const violations = Math.max(a.violations || 0, b.violations || 0);

  const aActivity = violationProfileActivityMs(a);
  const bActivity = violationProfileActivityMs(b);
  const name = (bActivity > aActivity ? b.name : a.name) || a.name || b.name || "Unknown";

  const aLastViolation = a.lastViolationAt || 0;
  const bLastViolation = b.lastViolationAt || 0;
  const lastViolationAt = Math.max(aLastViolation, bLastViolation);
  const reason = bLastViolation > aLastViolation ? b.reason : a.reason || b.reason || "";

  const lastSeenMs = Math.max(a.lastSeenMs || 0, b.lastSeenMs || 0);

  const aKnownCaptured = Number.isFinite(a?.lastKnown?.capturedMs) ? a.lastKnown.capturedMs : 0;
  const bKnownCaptured = Number.isFinite(b?.lastKnown?.capturedMs) ? b.lastKnown.capturedMs : 0;
  const lastKnown = bKnownCaptured > aKnownCaptured ? b.lastKnown : (a.lastKnown || b.lastKnown || null);
  const lastKnownSource = bKnownCaptured > aKnownCaptured
    ? b.lastKnownSource
    : (a.lastKnownSource || b.lastKnownSource || "");

  const aLoop = a.kickLoop ?? {};
  const bLoop = b.kickLoop ?? {};
  const enabled = !!aLoop.enabled || !!bLoop.enabled;
  const sinceCandidates = [aLoop.since, bLoop.since].filter((v) => Number.isFinite(v) && v > 0);
  const since = sinceCandidates.length ? Math.min(...sinceCandidates) : 0;
  const lastKickAt = Math.max(aLoop.lastKickAt || 0, bLoop.lastKickAt || 0);
  const intervalSource = bActivity >= aActivity ? bLoop.intervalSec : aLoop.intervalSec;
  const intervalSec = clampRangeInt(intervalSource, 1, 600, 10);

  return {
    name,
    violations,
    lastViolationAt,
    reason,
    kickLoop: { enabled, since, lastKickAt, intervalSec },
    lastSeenMs,
    lastKnown,
    lastKnownSource,
  };
}

function normalizeViolationsDb(obj) {
  const out = emptyViolationsDb();
  if (!obj || typeof obj !== "object") return out;

  const rawProfiles = obj.profiles && typeof obj.profiles === "object" ? obj.profiles : obj;
  let unnamedIndex = 0;

  for (const [rawKey, raw] of Object.entries(rawProfiles)) {
    const fallbackName = typeof rawKey === "string" && rawKey ? rawKey : `Unknown-${unnamedIndex++}`;
    const profile = normalizeViolationProfile(raw, fallbackName);
    const normalizedKey = normalizeViolationKey(profile.name || fallbackName) || normalizeViolationKey(fallbackName);
    if (!normalizedKey) continue;

    if (out.profiles[normalizedKey]) {
      out.profiles[normalizedKey] = mergeViolationProfiles(out.profiles[normalizedKey], profile);
    } else {
      out.profiles[normalizedKey] = profile;
    }
  }

  return out;
}

function loadViolationsDb() {
  if (violationsDbLoaded) return;
  violationsDbLoaded = true;

  if (!persistenceEnabled) {
    violationsDb = emptyViolationsDb();
    dbgWarn("violations", "Dynamic properties unavailable; violations registry will not persist.");
    return;
  }

  try {
    const raw = world.getDynamicProperty(VIOLATIONS_DB_KEY);
    if (typeof raw === "string" && raw.length > 0) {
      const parsed = JSON.parse(raw);
      violationsDb = normalizeViolationsDb(parsed);
      if (!parsed?.schema || !parsed?.profiles || violationsDb.schema !== VIOLATIONS_DB_SCHEMA) {
        violationsDb.schema = VIOLATIONS_DB_SCHEMA;
        violationsDbDirty = true;
      }
      dbgInfo("violations", "Loaded violations registry.");
      return;
    }

    const legacy = world.getDynamicProperty(VIOLATIONS_DB_LEGACY_KEY);
    if (typeof legacy === "string" && legacy.length > 0) {
      violationsDb = normalizeViolationsDb(JSON.parse(legacy));
      dbgWarn("violations", "Migrated legacy violators registry to violations registry.");
      violationsDbDirty = true;
      saveViolationsDbNow();
      return;
    }

    violationsDb = emptyViolationsDb();
    dbgInfo("violations", "No saved violations registry found; starting empty.");
  } catch (e) {
    dbgError("violations", `Unable to load violations registry; reset to empty: ${e}`);
    violationsDb = emptyViolationsDb();
  }
}

function saveViolationsDbNow() {
  if (!persistenceEnabled) return;
  if (!violationsDbDirty) return;

  try {
    const raw = safeStringifyWithCap(violationsDb, VIOLATIONS_DB_MAX_CHARS, emptyViolationsDb());
    world.setDynamicProperty(VIOLATIONS_DB_KEY, raw);
    violationsDbDirty = false;
    dbgInfo("violations", "Violations registry saved.");
  } catch (e) {
    dbgError("violations", `Unable to save violations registry: ${e}`);
  }
}

function queueSaveViolationsDb() {
  violationsDbDirty = true;
  if (!persistenceEnabled) return;
  if (violationsDbSaveQueued) return;

  violationsDbSaveQueued = true;
  runLater(() => {
    violationsDbSaveQueued = false;
    saveViolationsDbNow();
  }, 40);
}

system.runInterval(() => {
  try { saveViolationsDbNow(); } catch {}
}, 200);

runLater(loadViolationsDb, 1);
try {
  world.afterEvents?.worldInitialize?.subscribe?.(() => runLater(loadViolationsDb, 1));
} catch {}

system.runInterval(() => {
  try {
    if (!configLoaded) loadGlobalConfig();
    const tracking = globalConfig.tracking ?? DEFAULT_GLOBAL_CONFIG.tracking;
    if (!tracking?.enabled) return;
    const intervalSec = clampRangeInt(tracking.updateIntervalSeconds, 1, 600, 10);
    const now = Date.now();
    if (now - violationsDbLastTrackingMs < intervalSec * 1000) return;
    violationsDbLastTrackingMs = now;

    if (!violationsDbLoaded) loadViolationsDb();
    const profiles = violationsDb.profiles ?? {};
    let updated = false;

    for (const p of getPlayersSafe()) {
      const name = scoreKeyForPlayer(p);
      const key = normalizeViolationKey(name);
      if (!key) continue;

      let entry = profiles[key];
      if (!entry && !tracking.trackAllPlayers) continue;

      if (!entry) {
        entry = normalizeViolationProfile({}, name);
        profiles[key] = entry;
        updated = true;
      }

      const lastKnown = buildLastKnownFromPlayer(p, now);
      const shouldUpdateKnown = lastKnown && (!entry.lastKnown || lastKnown.capturedMs >= (entry.lastKnown.capturedMs || 0));

      const nextEntry = {
        ...entry,
        name,
        lastSeenMs: now,
        lastKnown: shouldUpdateKnown ? lastKnown : entry.lastKnown,
        lastKnownSource: shouldUpdateKnown ? "tracking" : entry.lastKnownSource,
      };

      profiles[key] = nextEntry;
      updated = true;

      lastSeenViolationsLocation.set(key, {
        lastKnown: nextEntry.lastKnown,
        name,
        lastSeenMs: now,
      });
    }

    if (updated) {
      violationsDb.profiles = profiles;
      queueSaveViolationsDb();
    }
  } catch (e) {
    dbgWarn("violations", `Last-seen location cache failed: ${e}`);
  }
}, 20);

function normalizeVioStats(obj) {
  const out = JSON.parse(JSON.stringify(DEFAULT_VIO_STATS));
  if (!obj || typeof obj !== "object") return out;

  out.globalCount = Number.isFinite(obj.globalCount) ? obj.globalCount : 0;

  const mr = obj.mostRecent;
  if (mr && typeof mr === "object") {
    out.mostRecent.t = typeof mr.t === "string" ? mr.t : "";
    out.mostRecent.player = typeof mr.player === "string" ? mr.player : "";
    out.mostRecent.type = typeof mr.type === "string" ? mr.type : "";
  }

  const tc = obj.typeCounts;
  if (tc && typeof tc === "object") {
    out.typeCounts.ghost   = Number.isFinite(tc.ghost)   ? tc.ghost   : 0;
    out.typeCounts.plant   = Number.isFinite(tc.plant)   ? tc.plant   : 0;
    out.typeCounts.hopper  = Number.isFinite(tc.hopper)  ? tc.hopper  : 0;
    out.typeCounts.dropper = Number.isFinite(tc.dropper) ? tc.dropper : 0;
    out.typeCounts.illegal = Number.isFinite(tc.illegal) ? tc.illegal : 0;
    out.typeCounts.other   = Number.isFinite(tc.other)   ? tc.other   : 0;
  }

  return out;
}

function loadVioStats() {
  if (vioStatsLoaded) return;
  vioStatsLoaded = true;

  if (!persistenceEnabled) {
    vioStats = normalizeVioStats(DEFAULT_VIO_STATS);
    dbgWarn("violations", "Dynamic properties unavailable; violation stats will not persist.");
    return;
  }

  try {
    const raw = world.getDynamicProperty(VIO_STATS_KEY);
    if (typeof raw !== "string" || raw.length === 0) {
      vioStats = normalizeVioStats(DEFAULT_VIO_STATS);
      dbgInfo("violations", "No saved violation stats found; starting from zero.");
      return;
    }
    vioStats = normalizeVioStats(JSON.parse(raw));
    dbgInfo("violations", "Loaded violation stats.");
  } catch (e) {
    console.warn(`[Anti-Dupe] Unable to load violation stats: ${e}`);
    dbgError("violations", `Unable to load violation stats; reset to defaults: ${e}`);
    vioStats = normalizeVioStats(DEFAULT_VIO_STATS);
  }
}

function saveVioStatsNow() {
  if (!persistenceEnabled) return;
  if (!vioStatsDirty) return;

  try {
    const raw = safeStringifyWithCap(vioStats, VIO_STATS_MAX_CHARS, DEFAULT_VIO_STATS);
    world.setDynamicProperty(VIO_STATS_KEY, raw);
    vioStatsDirty = false;
    dbgInfo("violations", "Violation stats saved.");
  } catch (e) {
    console.warn(`[Anti-Dupe] Unable to save violation stats: ${e}`);
    dbgError("violations", `Unable to save violation stats: ${e}`);
  }
}

function queueSaveVioStats() {
  vioStatsDirty = true;
  if (!persistenceEnabled) return;
  if (vioStatsSaveQueued) return;

  vioStatsSaveQueued = true;
  runLater(() => {
    vioStatsSaveQueued = false;
    saveVioStatsNow();
  }, 40);
}

system.runInterval(() => {
  try { saveVioStatsNow(); } catch {}
}, 200);

runLater(loadVioStats, 1);
try {
  world.afterEvents?.worldInitialize?.subscribe?.(() => runLater(loadVioStats, 1));
} catch {}

// Objective helpers
function ensureObjective(id, displayName) {
  try {
    const sb = world.scoreboard;
    if (!sb) {
      dbgOncePer("no_scoreboard", 200, "warn", "violations", "Scoreboard API unavailable (cannot create objectives).");
      return undefined;
    }

    let obj = sb.getObjective(id);
    if (!obj) {
      obj = sb.addObjective(id, displayName);
      dbgInfo("violations", `Created objective: ${id}`);
    }
    return obj;
  } catch (e) {
    console.warn(`[Anti-Dupe] ensureObjective(${id}) failed: ${e}`);
    dbgError("violations", `ensureObjective(${id}) error: ${e}`);
    return undefined;
  }
}

function ensureViolationObjectives() {
  if (vioObjectivesReady) return true;

  if (vioInitAttempted && !vioObjectivesReady) return false;
  vioInitAttempted = true;

  const objs = [
    ensureObjective(VIO_OBJ_TOTAL,   "Anti-Dupe Total Violations"),
    ensureObjective(VIO_OBJ_GHOST,   "Anti-Dupe Ghost Violations"),
    ensureObjective(VIO_OBJ_PLANT,   "Anti-Dupe Plant Violations"),
    ensureObjective(VIO_OBJ_HOPPER,  "Anti-Dupe Hopper Violations"),
    ensureObjective(VIO_OBJ_DROPPER, "Anti-Dupe Dropper Violations"),
    ensureObjective(VIO_OBJ_ILLEGAL, "Anti-Dupe Illegal Violations"),
    ensureObjective(VIO_OBJ_OTHER,   "Anti-Dupe Other Violations"),
    ensureObjective(VIO_OBJ_GLOBAL,  "Anti-Dupe Global Violations"),
  ];

  const ok = objs.every(Boolean);
  vioObjectivesReady = ok;

  if (ok) {
    dbgInfo("violations", "Violation objectives ready.");
  } else {
    dbgWarn("violations", "Violation objectives not ready; retry scheduled.");
    vioInitAttempted = false;
    runLater(ensureViolationObjectives, 40);
  }

  return ok;
}

runLater(ensureViolationObjectives, 20);
try {
  world.afterEvents?.worldInitialize?.subscribe?.(() => runLater(ensureViolationObjectives, 20));
} catch {}

function dupeTypeKey(dupeType) {
  // user-facing types: "Hopper Dupe", "Piston Dupe", etc.
  const s = String(dupeType ?? "").toLowerCase();
  if (s.includes("ghost")) return "ghost";
  if (s.includes("piston") || s.includes("plant")) return "plant";
  if (s.includes("hopper")) return "hopper";
  if (s.includes("dropper")) return "dropper";
  if (s.includes("illegal stack")) return "illegal";
  return "other";
}

function objectiveIdForKey(k) {
  switch (k) {
    case "ghost": return VIO_OBJ_GHOST;
    case "plant": return VIO_OBJ_PLANT;
    case "hopper": return VIO_OBJ_HOPPER;
    case "dropper": return VIO_OBJ_DROPPER;
    case "illegal": return VIO_OBJ_ILLEGAL;
    default: return VIO_OBJ_OTHER;
  }
}

function scoreKeyForPlayer(player) {
  return String(player?.name ?? player?.nameTag ?? "Unknown").trim();
}

function violationKeyForPlayer(player) {
  const name = scoreKeyForPlayer(player);
  return normalizeViolationKey(name);
}

function isBadOfflineScoreboardName(name) {
  const s = String(name ?? "");
  return s.includes("commands.scoreboard.players.offlinePlayerName");
}

function formatAgo(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "Unknown";
  const diff = Math.max(0, Date.now() - ms);
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

function buildLastKnownFromPlayer(player, capturedMs = Date.now()) {
  if (!player) return null;
  const pos = player.location ?? null;
  if (!pos) return null;
  const x = Number.isFinite(pos.x) ? clampInt(pos.x, 0) : null;
  const y = Number.isFinite(pos.y) ? clampInt(pos.y, 0) : null;
  const z = Number.isFinite(pos.z) ? clampInt(pos.z, 0) : null;
  const dimId = safeDimIdFromEntity(player);
  if (x === null && y === null && z === null && (!dimId || dimId === "unknown")) return null;
  return {
    x,
    y,
    z,
    dim: dimId || "unknown",
    capturedMs: Number.isFinite(capturedMs) ? capturedMs : Date.now(),
  };
}

function captureViolationLocation(player, source) {
  try {
    if (!player) return;
    if (!violationsDbLoaded) loadViolationsDb();
    const key = violationKeyForPlayer(player);
    if (!key) return;
    const entry = violationsDb.profiles?.[key];
    if (!entry) return;
    const now = Date.now();
    const lastKnown = buildLastKnownFromPlayer(player, now);
    if (!lastKnown) return;
    violationsDb.profiles[key] = {
      ...entry,
      name: scoreKeyForPlayer(player),
      lastSeenMs: now,
      lastKnown,
      lastKnownSource: source,
    };
    queueSaveViolationsDb();
  } catch (e) {
    dbgWarn("violations", `Unable to capture last known location: ${e}`);
  }
}

function tryGetScoreByEntityOrName(objective, entity, nameFallback) {
  if (!objective) return 0;

  try {
    const v = objective.getScore?.(nameFallback);
    if (Number.isFinite(v)) return v;
  } catch {}

  try {
    const v = objective.getScore?.(entity);
    if (Number.isFinite(v)) return v;
  } catch {}

  try {
    const scores = objective.getScores?.() ?? [];
    for (const s of scores) {
      const p = s?.participant;
      const dn = p?.displayName;
      if (dn && nameFallback && dn === nameFallback) return s?.score ?? 0;
    }
  } catch {}

  return 0;
}

function getScoreEntryByName(objective, nameKey) {
  if (!objective) return null;
  try {
    const scores = objective.getScores?.() ?? [];
    for (const s of scores) {
      const p = s?.participant;
      const dn = p?.displayName;
      if (dn && nameKey && dn === nameKey) {
        return { score: s?.score ?? 0, participant: p };
      }
    }
  } catch {}
  return null;
}

function readScoreForName(objective, nameKey) {
  if (!objective) return { found: false, score: 0, participant: null };
  const entry = getScoreEntryByName(objective, nameKey);
  if (entry) return { found: true, score: entry.score, participant: entry.participant };
  try {
    const v = objective.getScore?.(nameKey);
    if (Number.isFinite(v)) return { found: true, score: v, participant: null };
  } catch {}
  return { found: false, score: 0, participant: null };
}

function resetScore(objective, nameKey) {
  const info = readScoreForName(objective, nameKey);
  if (!info.found) return { found: false, previous: 0 };
  const prev = info.score ?? 0;
  try {
    if (typeof objective.setScore === "function") {
      objective.setScore(nameKey, 0);
      return { found: true, previous: prev };
    }
  } catch {}
  try {
    if (typeof objective.addScore === "function") {
      objective.addScore(nameKey, -prev);
      return { found: true, previous: prev };
    }
  } catch {}
  try {
    if (typeof objective.removeParticipant === "function") {
      objective.removeParticipant(info.participant ?? nameKey);
      return { found: true, previous: prev };
    }
  } catch {}
  return { found: true, previous: prev };
}

const migratedViolationNames = new Set();

function migrateViolationScoresForPlayer(player) {
  try {
    if (!player) return;
    const key = scoreKeyForPlayer(player);
    if (!key || migratedViolationNames.has(key)) return;

    ensureViolationObjectives();
    const sb = world.scoreboard;
    if (!sb) return;

    const objectives = [
      VIO_OBJ_TOTAL,
      VIO_OBJ_GHOST,
      VIO_OBJ_PLANT,
      VIO_OBJ_HOPPER,
      VIO_OBJ_DROPPER,
      VIO_OBJ_ILLEGAL,
      VIO_OBJ_OTHER,
    ];

    for (const objId of objectives) {
      const obj = sb.getObjective(objId);
      if (!obj) continue;

      let legacyScore = 0;
      let newScore = 0;

      try {
        const v = obj.getScore?.(player);
        if (Number.isFinite(v)) legacyScore = v;
      } catch {}

      try {
        const v = obj.getScore?.(key);
        if (Number.isFinite(v)) newScore = v;
      } catch {}

      if (legacyScore > 0) {
        const combined = Math.max(newScore, legacyScore);
        if (typeof obj.setScore === "function") {
          try { obj.setScore(key, combined); } catch {}
        } else if (combined > newScore) {
          try { obj.addScore?.(key, combined - newScore); } catch {}
        }

        if (typeof obj.removeParticipant === "function") {
          try { obj.removeParticipant(player); } catch {}
        } else if (typeof obj.setScore === "function") {
          try { obj.setScore(player, 0); } catch {}
        }
      }
    }

    migratedViolationNames.add(key);
  } catch (e) {
    dbgWarn("violations", `Violation score migration error: ${e}`);
  }
}

/**
 * Increments violations (per-player total + per-type + global),
 * updates persistent tallies, and returns the post-increment totals (best effort).
 */
function recordViolation(offender, incidentType) {
  try {
    if (!offender) return { key: "other", total: 0, typeScore: 0, global: 0 };

    if (!vioStatsLoaded) loadVioStats();
    ensureViolationObjectives();

    const key = dupeTypeKey(incidentType);
    const name = offender.nameTag ?? offender.name ?? "Unknown";
    const scoreKey = scoreKeyForPlayer(offender);

    try {
      const sb = world.scoreboard;
      if (sb) {
        const totalObj = sb.getObjective(VIO_OBJ_TOTAL);
        const typeObj  = sb.getObjective(objectiveIdForKey(key));
        const globObj  = sb.getObjective(VIO_OBJ_GLOBAL);

        totalObj?.addScore?.(scoreKey, 1);
        typeObj?.addScore?.(scoreKey, 1);
        globObj?.addScore?.(GLOBAL_PARTICIPANT, 1);
      } else {
        dbgOncePer("no_scoreboard_add", 200, "warn", "violations", "Cannot increment scores: scoreboard not available.");
      }
    } catch (e) {
      console.warn(`[Anti-Dupe] recordViolation scoreboard update failed: ${e}`);
      dbgError("violations", `recordViolation scoreboard update error: ${e}`);
    }

    vioStats.globalCount = (vioStats.globalCount | 0) + 1;

    if (!vioStats.typeCounts || typeof vioStats.typeCounts !== "object") {
      vioStats.typeCounts = { ghost: 0, plant: 0, hopper: 0, dropper: 0, illegal: 0, other: 0 };
    }
    vioStats.typeCounts[key] = (vioStats.typeCounts[key] | 0) + 1;

    vioStats.mostRecent = {
      t: new Date().toISOString(),
      player: name,
      type: String(incidentType ?? "Unknown"),
    };

    queueSaveVioStats();

    let total = 0;
    let typeScore = 0;
    let global = 0;

    try {
      const sb = world.scoreboard;
      if (sb) {
        const totalObj = sb.getObjective(VIO_OBJ_TOTAL);
        const typeObj  = sb.getObjective(objectiveIdForKey(key));
        const globObj  = sb.getObjective(VIO_OBJ_GLOBAL);

        total = tryGetScoreByEntityOrName(totalObj, offender, scoreKey);
        typeScore = tryGetScoreByEntityOrName(typeObj, offender, scoreKey);

        try {
          const g = globObj?.getScore?.(GLOBAL_PARTICIPANT);
          if (Number.isFinite(g)) global = g;
          else {
            const scores = globObj?.getScores?.() ?? [];
            for (const s of scores) {
              if (s?.participant?.displayName === GLOBAL_PARTICIPANT) { global = s?.score ?? 0; break; }
            }
          }
        } catch {}
      }
    } catch {}

    try {
      updateViolationRecordFromViolation(offender, total, incidentType);
    } catch (e) {
      dbgWarn("violations", `Violation registry update failed: ${e}`);
    }

    return { key, total, typeScore, global };
  } catch (e) {
    console.warn(`[Anti-Dupe] recordViolation failed: ${e}`);
    dbgError("violations", `recordViolation error: ${e}`);
    return { key: "other", total: 0, typeScore: 0, global: 0 };
  }
}

function updateViolationRecordFromViolation(player, total, incidentType) {
  if (!player) return;
  if (!violationsDbLoaded) loadViolationsDb();
  const key = violationKeyForPlayer(player);
  if (!key) return;
  const name = scoreKeyForPlayer(player);
  const now = Date.now();
  const profiles = violationsDb.profiles ?? (violationsDb.profiles = {});
  const existing = profiles[key] ?? normalizeViolationProfile({}, name);
  const violations = Number.isFinite(total) ? total : (existing.violations ?? 0);
  const lastKnown = buildLastKnownFromPlayer(player, now);
  profiles[key] = {
    ...existing,
    name,
    violations,
    lastViolationAt: now,
    reason: String(incidentType ?? ""),
    lastSeenMs: now,
    lastKnown: lastKnown ?? existing.lastKnown ?? null,
    lastKnownSource: lastKnown ? "violation" : existing.lastKnownSource,
    kickLoop: {
      enabled: !!existing?.kickLoop?.enabled,
      since: Number.isFinite(existing?.kickLoop?.since) ? existing.kickLoop.since : 0,
      lastKickAt: Number.isFinite(existing?.kickLoop?.lastKickAt) ? existing.kickLoop.lastKickAt : 0,
      intervalSec: Number.isFinite(existing?.kickLoop?.intervalSec) ? existing.kickLoop.intervalSec : 10,
    },
  };
  queueSaveViolationsDb();
}

function updateViolationNameForPlayer(player) {
  if (!player) return;
  if (!violationsDbLoaded) loadViolationsDb();
  const key = violationKeyForPlayer(player);
  if (!key) return;
  const name = scoreKeyForPlayer(player);
  const existing = violationsDb.profiles?.[key];
  if (!existing) return;
  if (existing.name !== name) {
    violationsDb.profiles[key] = { ...existing, name };
    queueSaveViolationsDb();
  }
}

function isKickLoopedByKey(key) {
  if (!violationsDbLoaded) loadViolationsDb();
  const normalized = normalizeViolationKey(key);
  const entry = violationsDb.profiles?.[normalized];
  return !!entry?.kickLoop?.enabled;
}

function setKickLoopForKey(key, enabled) {
  if (!violationsDbLoaded) loadViolationsDb();
  const normalized = normalizeViolationKey(key);
  if (!normalized) return;
  const entry = violationsDb.profiles?.[normalized] ?? normalizeViolationProfile({}, "Unknown");
  const now = Date.now();
  const kickLoop = entry.kickLoop && typeof entry.kickLoop === "object" ? entry.kickLoop : {};
  violationsDb.profiles[normalized] = {
    ...entry,
    kickLoop: {
      enabled: !!enabled,
      since: enabled ? (kickLoop.since || now) : kickLoop.since || 0,
      lastKickAt: kickLoop.lastKickAt || 0,
      intervalSec: Number.isFinite(kickLoop.intervalSec) ? kickLoop.intervalSec : 10,
    },
  };
  queueSaveViolationsDb();
}

const lastPunishTickByPlayerName = new Map();
const lastSeenViolationsLocation = new Map();

function appendMitigation(base, addition) {
  const a = String(base ?? "").trim();
  const b = String(addition ?? "").trim();
  if (!a) return b;
  if (!b) return a;
  return `${a} | ${b}`;
}

function renderPunishmentReason(template, typeLabel, count, threshold) {
  const rawInput = String(template ?? "").trim();
  const raw = rawInput || DEFAULT_GLOBAL_CONFIG.punishments.reasonTemplate;
  return raw
    .replace(/\{TYPE\}/g, String(typeLabel))
    .replace(/\{COUNT\}/g, String(count))
    .replace(/\{THRESHOLD\}/g, String(threshold));
}

async function tryKickPlayer(player, reason) {
  try {
    const name = String(player?.name ?? "").trim();
    if (!name) return false;
    captureViolationLocation(player, "kick");
    const dim = player?.dimension ?? world.getDimension("overworld");
    const safeReason = String(reason ?? "").replace(/"/g, "'").slice(0, 120);
    if (typeof dim?.runCommandAsync === "function") {
      await dim.runCommandAsync(`kick "${name}" "${safeReason}"`);
      return true;
    }
    if (typeof dim?.runCommand === "function") {
      dim.runCommand(`kick "${name}" "${safeReason}"`);
      return true;
    }
  } catch (e) {
    dbgWarn("punish", `Kick command error: ${e}`);
  }
  return false;
}

async function applyPunishment(player, incidentType, itemDesc, loc, vio) {
  try {
    if (!player) return "";
    const name = String(player?.name ?? "").trim();
    if (!name) return "";
    if (player.hasTag?.(ADMIN_TAG)) return "";

    if (!configLoaded) loadGlobalConfig();
    const punish = globalConfig.punishments;
    if (!punish?.enabled) return "";

    const bypassTag = String(punish.bypassTag ?? "").trim();
    if (bypassTag && player.hasTag?.(bypassTag)) {
      dbgInfo("punish", `Punishment gated for ${name}: bypass tag present (${bypassTag}).`);
      return "";
    }

    const key = dupeTypeKey(incidentType);
    const typeSettings = punish.types?.[key] ?? punish.types?.other;
    if (!typeSettings?.enabled) return "";

    const threshold = clampRangeInt(typeSettings.threshold, 0, 200, 0);
    const thresholdEnabled = threshold > 0;

    const typeLabel = prettyTypeKey(key);
    const typeScore = Number.isFinite(vio?.typeScore) ? vio.typeScore : 0;

    let mitigationNote = "";
    const typeTag = String(typeSettings.tag ?? "").trim();
    const globalTag = String(punish.punishmentTag ?? "").trim();
    const effectiveTag = typeTag || globalTag;

    if (typeSettings.kickIfTaggedOnRepeat) {
      if (!effectiveTag) {
        dbgInfo("punish", `Repeat kick gated for ${name}: no punishment tag configured.`);
      } else if (player.hasTag?.(effectiveTag)) {
        if (!punish.allowKick) {
          dbgInfo("punish", `Repeat kick gated for ${name}: global kicks disabled.`);
        } else {
          const now = system.currentTick;
          const last = lastPunishTickByPlayerName.get(name) ?? -999999;
          const cooldown = clampRangeInt(punish.cooldownTicks, 0, 200, 20);
          if (now - last < cooldown) {
            dbgInfo("punish", `Repeat kick gated for ${name}: cooldown active (${cooldown} ticks).`);
          } else {
            const reason = renderPunishmentReason(punish.reasonTemplate, typeLabel, typeScore, threshold);
            const kicked = await tryKickPlayer(player, reason);
            lastPunishTickByPlayerName.set(name, now);
            if (kicked) {
              mitigationNote = appendMitigation(mitigationNote, "Punishment: Kicked (Repeat Offender Tag)");
              const dimId = safeDimIdFromEntity(player);
              const dimLabel = prettyDimension(dimId);
              const pos = player.location ?? loc;
              const coordStr = pos ? `${clampInt(pos.x)}, ${clampInt(pos.y)}, ${clampInt(pos.z)}` : "Unknown";
              sendAdminAlert(`§c<Anti-Dupe>§r §6Punishment:§r ${name} §7was kicked for repeat §f${typeLabel}§r §7violations at §e§l${dimLabel}§r §7(§e${coordStr}§7).§r`);
              if (punish.publicKickMessage) {
                for (const p of getPlayersSafe()) {
                  if (!p?.hasTag?.(DISABLE_PUBLIC_MSG_TAG)) {
                    try { p.sendMessage(`§c<Anti-Dupe>§r §f${name}§r §7was removed for repeated §f${typeLabel}§r §7violations.`); } catch {}
                  }
                }
              }
            }
          }
        }
        return mitigationNote;
      }
    }

    if (typeTag) {
      if (!player.hasTag?.(typeTag)) {
        player.addTag?.(typeTag);
        mitigationNote = appendMitigation(mitigationNote, `Punishment: Tag Added (${typeTag})`);
      }
    }

    if (effectiveTag && thresholdEnabled && typeScore >= threshold && !player.hasTag?.(effectiveTag)) {
      player.addTag?.(effectiveTag);
      mitigationNote = appendMitigation(mitigationNote, `Punishment: Tag Added (${effectiveTag})`);
    }

    if (thresholdEnabled && typeScore >= threshold) {
      if (!punish.allowKick) {
        dbgInfo("punish", `Kick gated for ${name}: global kicks disabled.`);
      } else if (!typeSettings.kickAtThreshold) {
        dbgInfo("punish", `Kick gated for ${name}: kick at threshold disabled for ${typeLabel}.`);
      } else {
        const now = system.currentTick;
        const last = lastPunishTickByPlayerName.get(name) ?? -999999;
        const cooldown = clampRangeInt(punish.cooldownTicks, 0, 200, 20);
        if (now - last < cooldown) {
          dbgInfo("punish", `Kick gated for ${name}: cooldown active (${cooldown} ticks).`);
        } else {
          const reason = renderPunishmentReason(punish.reasonTemplate, typeLabel, typeScore, threshold);
          const kicked = await tryKickPlayer(player, reason);
          lastPunishTickByPlayerName.set(name, now);
          if (kicked) {
            mitigationNote = appendMitigation(mitigationNote, `Punishment: Kicked at Threshold (${typeScore}/${threshold})`);
            const dimId = safeDimIdFromEntity(player);
            const dimLabel = prettyDimension(dimId);
            const pos = player.location ?? loc;
            const coordStr = pos ? `${clampInt(pos.x)}, ${clampInt(pos.y)}, ${clampInt(pos.z)}` : "Unknown";
            const tagNote = effectiveTag ? ` Tag: ${effectiveTag}.` : "";
            sendAdminAlert(`§c<Anti-Dupe>§r §6Punishment:§r ${name} §7was kicked for §f${typeLabel}§r §7violations (${typeScore}/${threshold}) at §e§l${dimLabel}§r §7(§e${coordStr}§7).§r${tagNote}`);
            if (punish.publicKickMessage) {
              for (const p of getPlayersSafe()) {
                if (!p?.hasTag?.(DISABLE_PUBLIC_MSG_TAG)) {
                  try { p.sendMessage(`§c<Anti-Dupe>§r §f${name}§r §7was removed for repeated §f${typeLabel}§r §7violations.`); } catch {}
                }
              }
            }
          }
        }
      }
    }

    return mitigationNote;
  } catch (e) {
    dbgWarn("punish", `applyPunishment error: ${e}`);
    return "";
  }
}

function evaluateKickEligibilityForPlayer(player) {
  if (!player) return null;
  const name = scoreKeyForPlayer(player);
  if (!name) return null;
  if (player.hasTag?.(ADMIN_TAG)) return null;

  if (!configLoaded) loadGlobalConfig();
  const punish = globalConfig.punishments;
  if (!punish?.enabled) return null;

  const bypassTag = String(punish.bypassTag ?? "").trim();
  if (bypassTag && player.hasTag?.(bypassTag)) {
    dbgInfo("punish", `Join kick gated for ${name}: bypass tag present (${bypassTag}).`);
    return null;
  }

  if (!ensureViolationObjectives()) return null;
  migrateViolationScoresForPlayer(player);

  const sb = world.scoreboard;
  if (!sb) return null;

  const keys = ["ghost", "plant", "hopper", "dropper", "illegal", "other"];
  let best = null;
  let sawOverThreshold = false;

  for (const key of keys) {
    const typeSettings = punish.types?.[key];
    if (!typeSettings?.enabled) continue;
    const threshold = clampRangeInt(typeSettings.threshold, 0, 200, 0);
    if (threshold <= 0) continue;
    const obj = sb.getObjective(objectiveIdForKey(key));
    if (!obj) continue;
    const typeScore = tryGetScoreByEntityOrName(obj, player, name);
    if (typeScore >= threshold) {
      sawOverThreshold = true;
      if (!typeSettings.kickAtThreshold) {
        dbgInfo("punish", `Join kick gated for ${name}: kick at threshold disabled for ${prettyTypeKey(key)}.`);
        continue;
      }
      if (!punish.allowKick) continue;
      const ratio = threshold > 0 ? typeScore / threshold : typeScore;
      if (!best || ratio > best.ratio || (ratio === best.ratio && typeScore > best.typeScore)) {
        best = { key, typeScore, threshold, ratio };
      }
    }
  }

  if (sawOverThreshold && !punish.allowKick) {
    dbgInfo("punish", `Join kick gated for ${name}: global kicks disabled.`);
  }

  if (!best || !punish.allowKick) return null;

  const now = system.currentTick;
  const last = lastPunishTickByPlayerName.get(name) ?? -999999;
  const cooldown = clampRangeInt(punish.cooldownTicks, 0, 200, 20);
  if (now - last < cooldown) {
    dbgInfo("punish", `Join kick gated for ${name}: cooldown active (${cooldown} ticks).`);
    return null;
  }

  const typeLabel = prettyTypeKey(best.key);
  const reason = renderPunishmentReason(
    punish.reasonTemplate,
    typeLabel,
    best.typeScore,
    best.threshold
  );

  return { key: best.key, typeScore: best.typeScore, threshold: best.threshold, typeLabel, reason };
}

async function kickPlayerForExistingViolations(player, details) {
  if (!player || !details) return false;
  const name = String(player?.name ?? "").trim();
  if (!name) return false;
  const now = system.currentTick;
  captureViolationLocation(player, "kick");
  const kicked = await tryKickPlayer(player, details.reason);
  lastPunishTickByPlayerName.set(name, now);
  if (!kicked) return false;

  const pos = player.location ?? {};
  const coordStr = (Number.isFinite(pos.x) && Number.isFinite(pos.y) && Number.isFinite(pos.z))
    ? `${clampInt(pos.x)}, ${clampInt(pos.y)}, ${clampInt(pos.z)}`
    : "Unknown";
  const dimId = safeDimIdFromEntity(player);
  const dimLabel = prettyDimension(dimId);

  sendAdminAlert(
    `§c<Anti-Dupe>§r §6Punishment:§r ${name} §7was kicked on join for existing §f${details.typeLabel}§r ` +
    `§7violations (${details.typeScore}/${details.threshold}) at §e§l${dimLabel}§r §7(§e${coordStr}§7).§r`
  );

  const punish = globalConfig.punishments;
  if (punish.publicKickMessage) {
    for (const p of getPlayersSafe()) {
      if (!p?.hasTag?.(DISABLE_PUBLIC_MSG_TAG)) {
        try { p.sendMessage(`§c<Anti-Dupe>§r §f${name}§r §7was removed for §f${details.typeLabel}§r §7violations.`); } catch {}
      }
    }
  }
  return true;
}

async function enforceKickLoopOnJoin(player) {
  if (!player) return false;
  if (player.hasTag?.(ADMIN_TAG)) return false;
  if (!configLoaded) loadGlobalConfig();
  const bypassTag = String(globalConfig.punishments?.bypassTag ?? "").trim();
  if (bypassTag && player.hasTag?.(bypassTag)) return false;
  if (!violationsDbLoaded) loadViolationsDb();
  const key = violationKeyForPlayer(player);
  if (!key) return false;
  const entry = violationsDb.profiles?.[key];
  if (!entry?.kickLoop?.enabled) return false;
  const now = Date.now();
  const intervalSec = Number.isFinite(entry.kickLoop.intervalSec) ? entry.kickLoop.intervalSec : 10;
  const minMs = Math.max(1, intervalSec) * 1000;
  const lastKickAt = Number.isFinite(entry.kickLoop.lastKickAt) ? entry.kickLoop.lastKickAt : 0;
  if (lastKickAt && now - lastKickAt < minMs) return false;

  const name = scoreKeyForPlayer(player);
  const reason = renderPunishmentReason(
    globalConfig.punishments?.reasonTemplate,
    "Kick Loop",
    entry.violations ?? 0,
    0
  );
  captureViolationLocation(player, "kick");
  const kicked = await tryKickPlayer(player, reason);
  if (kicked) {
    violationsDb.profiles[key] = {
      ...entry,
      name,
      kickLoop: {
        ...entry.kickLoop,
        lastKickAt: now,
      },
    };
    queueSaveViolationsDb();
  }
  return kicked;
}

function getViolationsTable() {
  try {
    const sb = world.scoreboard;
    if (!sb) return { rows: [], note: "Scoreboard unavailable." };

    const totalObj = sb.getObjective(VIO_OBJ_TOTAL);
    if (!totalObj) return { rows: [], note: "Violation objectives are not initialized yet." };

    let scores = [];
    try {
      scores = totalObj.getScores?.() ?? [];
    } catch (e) {
      return { rows: [], note: `Could not read scores: ${e}` };
    }

    const rows = [];
    let hiddenLegacy = 0;
    for (const info of scores) {
      const participant = info?.participant;
      const total = info?.score ?? 0;
      if (!participant || total <= 0) continue;

      const pname = participant.displayName ?? "Unknown";
      if (pname === GLOBAL_PARTICIPANT) continue;
      if (isBadOfflineScoreboardName(pname)) {
        hiddenLegacy++;
        continue;
      }

      const ghostObj = sb.getObjective(VIO_OBJ_GHOST);
      const plantObj = sb.getObjective(VIO_OBJ_PLANT);
      const hopObj   = sb.getObjective(VIO_OBJ_HOPPER);
      const dropObj  = sb.getObjective(VIO_OBJ_DROPPER);
      const illegalObj = sb.getObjective(VIO_OBJ_ILLEGAL);
      const otherObj = sb.getObjective(VIO_OBJ_OTHER);

      const ghost = tryGetScoreByEntityOrName(ghostObj, participant, pname);
      const plant = tryGetScoreByEntityOrName(plantObj, participant, pname);
      const hopper = tryGetScoreByEntityOrName(hopObj, participant, pname);
      const dropper = tryGetScoreByEntityOrName(dropObj, participant, pname);
      const illegal = tryGetScoreByEntityOrName(illegalObj, participant, pname);
      const other = tryGetScoreByEntityOrName(otherObj, participant, pname);

      rows.push({ name: pname, total, ghost, plant, hopper, dropper, illegal, other });
    }

    rows.sort((a, b) => (b.total - a.total) || a.name.localeCompare(b.name));
    const note = hiddenLegacy > 0 ? `Hidden legacy offline entries: ${hiddenLegacy}` : "";
    return { rows, note };
  } catch (e) {
    return { rows: [], note: `Violations table error: ${e}` };
  }
}

function getMostUsedViolationType() {
  const tc = vioStats?.typeCounts;
  if (!tc || typeof tc !== "object") return { key: "None", count: 0 };

  let bestKey = "None";
  let best = 0;

  for (const k of ["ghost", "plant", "hopper", "dropper", "illegal", "other"]) {
    const v = Number.isFinite(tc[k]) ? tc[k] : 0;
    if (v > best) {
      best = v;
      bestKey = k;
    }
  }
  return { key: bestKey, count: best };
}

function prettyTypeKey(k) {
  switch (k) {
    case "ghost": return "Ghost Stack";
    case "plant": return "Piston";
    case "hopper": return "Hopper";
    case "dropper": return "Dropper";
    case "illegal": return "Illegal Stack";
    case "other": return "Other";
    default: return String(k ?? "Unknown");
  }
}

// --- Incident Logs ---
// Stored keys are compact to fit dynamic property limits.
let dupeLogs = [];
let logsLoaded = false;
let logsDirty = false;
let saveQueued = false;

function safeStringifyLogs(arr) {
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
    dupeLogs = [];
    dbgWarn("logs", "Dynamic properties unavailable; incident logs will not persist.");
    return;
  }

  try {
    const raw = world.getDynamicProperty(DUPE_LOGS_KEY);
    if (typeof raw !== "string" || raw.length === 0) {
      dupeLogs = [];
    dbgInfo("logs", "No saved incident logs found.");
      return;
    }
    const parsed = JSON.parse(raw);
    dupeLogs = Array.isArray(parsed) ? parsed : [];
    dbgInfo("logs", `Loaded incident logs (count=${dupeLogs.length}).`);
  } catch (e) {
    console.warn(`[Anti-Dupe] Unable to load logs: ${e}`);
    dbgError("logs", `Unable to load incident logs; reset to empty: ${e}`);
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
    dbgInfo("logs", "Incident logs saved.");
  } catch (e) {
    console.warn(`[Anti-Dupe] Unable to save logs: ${e}`);
    dbgError("logs", `Unable to save incident logs: ${e}`);
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
  }, 40);
}

function addDupeLog(entry) {
  dupeLogs.push(entry);
  if (dupeLogs.length > 100) dupeLogs.shift();
  queueSaveLogs();
}

runLater(loadLogs, 1);
try {
  world.afterEvents?.worldInitialize?.subscribe?.(() => runLater(loadLogs, 1));
} catch {}

system.runInterval(() => {
  try { saveLogsNow(); } catch {}
}, 200);

// --- Incident Log Formatting ---
function parseLegacyLogString(s) {
  // Legacy format: `${stamp} | ${name} | ${dupeType} | ${itemDesc} | ${coordStr} | nearby: ${nearList}`
  try {
    const parts = String(s).split(" | ");
    if (parts.length < 5) return null;

    const t = parts[0] ?? "";
    const p = parts[1] ?? "Unknown";
    const ty = parts[2] ?? "Unknown";
    const it = parts[3] ?? "";

    const coordStr = parts[4] ?? "";
    const m = coordStr.match(/(-?\d+)\s*,\s*(-?\d+)\s*,\s*(-?\d+)/);
    const x = m ? clampInt(m[1]) : 0;
    const y = m ? clampInt(m[2]) : 0;
    const z = m ? clampInt(m[3]) : 0;

    let near = "";
    if (parts.length >= 6) near = String(parts[5] ?? "").replace(/^nearby:\s*/i, "").trim();
    const n = near && near.toLowerCase() !== "none" ? near.split(",").map(v => v.trim()).filter(Boolean) : [];

    // Dimension cannot be recovered from old entries
    return { t, p, ty, it, d: "unknown", x, y, z, n, m: "" };
  } catch {
    return null;
  }
}

function formatIncidentEntry(entry) {
  const e = (typeof entry === "string")
    ? (parseLegacyLogString(entry) ?? { t: "", p: "Unknown", ty: String(entry) })
    : entry;

  const username = e?.p ?? "Unknown";
  const time = e?.t ?? "";
  const type = e?.ty ?? "Unknown";
  const item = e?.it ?? "";
  const dimId = e?.d ?? "unknown";
  const dimLabel = prettyDimension(dimId);

  const x = Number.isFinite(e?.x) ? e.x : clampInt(e?.x, 0);
  const y = Number.isFinite(e?.y) ? e.y : clampInt(e?.y, 0);
  const z = Number.isFinite(e?.z) ? e.z : clampInt(e?.z, 0);

  const nearbyArr = Array.isArray(e?.n) ? e.n : [];
  const nearby = nearbyArr.length ? nearbyArr.join(", ") : "None";

  const vk = e?.vk ? String(e.vk) : "";
  const vTotal = Number.isFinite(e?.vt) ? e.vt : null;
  const vType = Number.isFinite(e?.vty) ? e.vty : null;

  const mitigation = e?.m ? String(e.m) : "";

  const lines = [];
  const formatted = formatIsoUtcSplit(time);

  lines.push(`Username: ${username}`);
  lines.push(`Date: ${formatted.date}`);
  lines.push(`Time: ${formatted.time}`);
  lines.push(`Incident Type: ${type}`);
  if (item) lines.push(`Item/Context: ${item}`);
  lines.push(`Dimension: ${dimLabel}${dimId && dimId !== "unknown" ? ` (${dimId})` : ""}`);
  lines.push(`Coordinates: ${x}, ${y}, ${z}`);
  lines.push(`Nearby Players: ${nearby}`);

  if (vTotal !== null) lines.push(`Total Violations (After): ${vTotal}`);
  if (vk && vType !== null) lines.push(`Violations for Type (After): ${prettyTypeKey(vk)} (${vType})`);
  if (mitigation) lines.push(`Mitigation: ${mitigation}`);

  lines.push("");
  lines.push("---");

  return lines.join("\n");
}

function formatIncidentLogsText(maxEntries = 25) {
  const total = dupeLogs.length;
  if (total === 0) return "No incident logs found.";

  const newestFirst = [...dupeLogs].reverse();
  const slice = newestFirst.slice(0, maxEntries);
  const blocks = slice.map(formatIncidentEntry);

  let header = `Incident Logs (${Math.min(total, maxEntries)}/${total} Shown)\n\n`;
  let body = blocks.join("\n");

  if (total > maxEntries) {
    body += `\n\n---\n\nNote: ${total - maxEntries} older entr${total - maxEntries === 1 ? "y" : "ies"} not shown.`;
  }

  return header + body;
}

function getMostRecentIncidentSummary() {
  try {
    if (!dupeLogs.length) return "None";
    const latest = dupeLogs[dupeLogs.length - 1];
    const e = (typeof latest === "string") ? parseLegacyLogString(latest) : latest;
    const p = e?.p ?? "Unknown";
    const ty = e?.ty ?? "Unknown";
    const t = e?.t ?? "";
    const formatted = formatIsoUtcSplit(t);
    return `${p} — ${ty}${t ? ` @ ${formatted.combined}` : ""}`;
  } catch {
    return "Unknown";
  }
}

// --- Nearby Players ---
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

// --- Alerts and Reporting ---
function sendAdminAlert(message) {
  const admins = getPlayersSafe().filter((p) => p?.hasTag?.(ADMIN_TAG));
  if (!admins.length) {
    dbgOncePer("no_admins", 200, "warn", "alerts", "No admins online to receive admin alerts.");
  }

  for (const admin of admins) {
    if (admin.hasTag?.(DISABLE_ADMIN_MSG_TAG) || admin.hasTag?.(DISABLE_ALERT_TAG)) continue;
    try { admin.sendMessage(message); } catch (e) {
      dbgWarn("alerts", `Unable to send admin alert to ${admin?.nameTag ?? "admin"}: ${e}`);
    }
  }
}

// reportIncident: records a violation, writes a log entry, and sends messages.
async function reportIncident(offender, incidentType, itemDesc, loc, mitigation = "", mode = "attempt", messageNote = "") {
  try {
    if (!offender || !loc) {
      dbgWarn("incident", "reportIncident called with missing offender or location.");
      return;
    }

    if (!logsLoaded) loadLogs();
    if (!vioStatsLoaded) loadVioStats();

    const name = offender.nameTag ?? offender.name ?? "Unknown";
    const stamp = new Date().toISOString();

    const dimId = safeDimIdFromEntity(offender);
    const dimLabel = prettyDimension(dimId);

    const x = clampInt(loc.x);
    const y = clampInt(loc.y);
    const z = clampInt(loc.z);

    const nearbyArr = getNearbyPlayers(offender, loc, 50, 12);
    const nearList = nearbyArr.length > 0 ? nearbyArr.join(", ") : "None";
    const coordStr = `${x}, ${y}, ${z}`;

    // 1) Violation increments (best effort)
    const vio = recordViolation(offender, incidentType);
    const punishmentNote = await applyPunishment(offender, incidentType, itemDesc, loc, vio);
    const mitigationText = appendMitigation(mitigation, punishmentNote);

    // 2) Log entry
    addDupeLog({
      t: stamp,
      p: name,
      ty: String(incidentType ?? "Unknown"),
      it: String(itemDesc ?? ""),
      d: dimId,
      x, y, z,
      n: nearbyArr,
      vt: Number.isFinite(vio?.total) ? vio.total : undefined,
      vty: Number.isFinite(vio?.typeScore) ? vio.typeScore : undefined,
      vk: vio?.key ? String(vio.key) : undefined,
      m: String(mitigationText ?? ""),
    });

    // 3) Messaging
    const noteText = messageNote ? ` §7${messageNote}§r` : "";
    const baseTag = "§c<Anti-Dupe>§r";
    const who = `§f§l${name}§r`;

    let broadcastMsg;
    let adminMsg;

    if (mode === "detected") {
      broadcastMsg = `${baseTag} ${who} §7was found with §f${incidentType}§r§7: §f${itemDesc}§r.§7 Item removed.§r${noteText}`;
      adminMsg = `${baseTag} §6Admin Alert:§r ${who} §7was found with §f${incidentType}§r§7: §f${itemDesc}§r ` +
                 `§7at §e§l${dimLabel}§r §7(§e${coordStr}§7).§r\n§7Nearby Players: §e${nearList}§r.${noteText}`;
    } else {
      broadcastMsg = `${baseTag} ${who} §7attempted a §f${incidentType}§r §7with §f${itemDesc}§r.§r${noteText}`;
      adminMsg = `${baseTag} §6Admin Alert:§r ${who} §7attempted a §f${incidentType}§r §7with §f${itemDesc}§r ` +
                 `§7at §e§l${dimLabel}§r §7(§e${coordStr}§7).§r\n§7Nearby Players: §e${nearList}§r.${noteText}`;
    }

    for (const p of getPlayersSafe()) {
      if (!p?.hasTag?.(DISABLE_PUBLIC_MSG_TAG)) {
        try { p.sendMessage(broadcastMsg); } catch (e) {
          dbgWarn("alerts", `Unable to send public message: ${e}`);
        }
      }
    }
    sendAdminAlert(adminMsg);

    dbgInfo("incident", `${name} | ${mode} | ${incidentType} | ${itemDesc} | ${dimId} @ ${coordStr}`);
  } catch (e) {
    console.warn(`[Anti-Dupe] reportIncident failed: ${e}`);
    dbgError("incident", `reportIncident error: ${e}`);
  }
}

// Convenience wrappers
function alertDupe(offender, dupeType, itemDesc, loc, mitigation = "", messageNote = "") {
  reportIncident(offender, dupeType, itemDesc, loc, mitigation, "attempt", messageNote);
}
function alertDetected(offender, incidentType, itemDesc, loc, mitigation = "", messageNote = "") {
  reportIncident(offender, incidentType, itemDesc, loc, mitigation, "detected", messageNote);
}

// --- Ghost Stack Patch ---
world.afterEvents.playerSpawn.subscribe(({ player, initialSpawn }) => {
  try {
    if (!initialSpawn || !player) return;

    migrateViolationScoresForPlayer(player);
    runLater(() => {
      try {
        if (!player || player.isValid === false) return;
        updateViolationNameForPlayer(player);
        enforceKickLoopOnJoin(player);
        const details = evaluateKickEligibilityForPlayer(player);
        if (details) kickPlayerForExistingViolations(player, details);
      } catch (e) {
        dbgWarn("punish", `Join enforcement failed: ${e}`);
      }
    }, 60);

    if (!configLoaded) loadGlobalConfig();
    if (!globalConfig.ghostPatch) {
      dbgOncePer("ghost_disabled", 600, "info", "ghost", "Ghost Stack Patch is disabled (configuration).");
      return;
    }

    const cursor = getCursorInventory(player);
    const invCont = getEntityInventoryContainer(player);
    if (!cursor || !invCont) {
      dbgOncePer("ghost_missing_inv", 600, "warn", "ghost", "Ghost check skipped: missing cursor or inventory component.");
      return;
    }

    const held = cursor.item;
    const empty = invCont.emptySlotsCount;

    if (held && held.amount === held.maxAmount && empty === 0) {
      try {
        player.dimension.spawnItem(new ItemStack(held.typeId, 1), player.location);
      } catch (e) {
        dbgWarn("ghost", `Unable to spawn item in ghost patch: ${e}`);
      }

      try { cursor.clear(); } catch (e) {
        dbgWarn("ghost", `Unable to clear cursor inventory: ${e}`);
      }

      alertDupe(
        player,
        "Ghost Stack Dupe",
        `${held.amount}x ${held.typeId}`,
        player.location,
        "Cursor cleared; 1 item dropped; ghost stack prevented."
      );
    } else {
      dbgOncePer("ghost_no_action", 600, "info", "ghost", "Ghost spawn check completed; no action required.");
    }
  } catch (e) {
    console.warn(`[Anti-Dupe] Ghost patch error: ${e}`);
    dbgError("ghost", `Ghost patch error: ${e}`);
  }
});

try {
  world.afterEvents?.playerLeave?.subscribe?.((event) => {
    try {
      const name = String(event?.playerName ?? "").trim();
      if (!name) return;
      if (!violationsDbLoaded) loadViolationsDb();
      const key = normalizeViolationKey(name);
      const entry = violationsDb.profiles?.[key];
      if (!entry) return;
      const cached = lastSeenViolationsLocation.get(key);
      const lastKnown = cached?.lastKnown ?? entry.lastKnown ?? null;
      violationsDb.profiles[key] = {
        ...entry,
        name,
        lastSeenMs: Date.now(),
        lastKnown,
        lastKnownSource: lastKnown ? "logout" : entry.lastKnownSource,
      };
      queueSaveViolationsDb();
    } catch (e) {
      dbgWarn("violations", `Player leave location capture failed: ${e}`);
    }
  });
} catch (e) {
  dbgWarn("violations", `playerLeave subscription failed: ${e}`);
}

// --- Illegal Stack Size Enforcement ---
function isIllegalAmount(amount, maxAmount) {
  if (!Number.isFinite(amount)) return true;
  if (amount <= 0) return true; // catches "beneath 0" and 0
  const mx = Number.isFinite(maxAmount) ? maxAmount : ILLEGAL_STACK_HARD_CAP;
  if (amount > mx) return true;
  if (amount > ILLEGAL_STACK_HARD_CAP) return true;
  return false;
}

function buildIllegalSummary(list, maxParts = 5) {
  const parts = [];
  const shown = list.slice(0, maxParts);

  for (const f of shown) {
    parts.push(`${f.amount}x ${f.typeId} (slot ${f.slot}; max ${f.max})`);
  }
  if (list.length > maxParts) parts.push(`+${list.length - maxParts} more`);
  return parts.join(", ");
}

function enforceIllegalStacksForPlayer(player) {
  try {
    if (!player?.location) return;

    if (!configLoaded) loadGlobalConfig();
    if (!globalConfig.illegalStackPatch) {
      dbgOncePer("illegal_disabled", 600, "info", "illegal", "Illegal Stack Patch is disabled (configuration).");
      return;
    }

    const cont = getEntityInventoryContainer(player);
    if (!cont) {
      dbgOncePer("illegal_missing_inv", 600, "warn", "illegal", "Illegal stack scan skipped: missing inventory component.");
      return;
    }

    const findings = [];

    // Inventory slots
    for (let slot = 0; slot < cont.size; slot++) {
      const stack = cont.getItem(slot);
      if (!stack) continue;

      const amt = Number(stack.amount);
      const mx = Number(stack.maxAmount ?? ILLEGAL_STACK_HARD_CAP);

      if (isIllegalAmount(amt, mx)) {
        findings.push({ slot, typeId: stack.typeId, amount: amt, max: mx });
        clearContainerSlot(cont, slot);
      }
    }

    // Cursor slot (if present)
    try {
      const cursor = getCursorInventory(player);
      const cItem = cursor?.item;
      if (cItem) {
        const amt = Number(cItem.amount);
        const mx = Number(cItem.maxAmount ?? ILLEGAL_STACK_HARD_CAP);
        if (isIllegalAmount(amt, mx)) {
          findings.push({ slot: "cursor", typeId: cItem.typeId, amount: amt, max: mx });
          try { cursor.clear(); } catch {}
        }
      }
    } catch (e) {
      dbgWarn("illegal", `Cursor scan error: ${e}`);
    }

    if (!findings.length) return;

    const summary = buildIllegalSummary(findings, 5);
    const count = findings.length;

    alertDetected(
      player,
      "Illegal Stack Size",
      `${count} stack(s) removed: ${summary}`,
      player.location,
      "Illegal stack sizes removed from inventory."
    );

    dbgWarn("illegal", `Removed illegal stacks from ${player.nameTag ?? player.name ?? "player"}: ${summary}`);
  } catch (e) {
    console.warn(`[Anti-Dupe] Illegal stack enforcement failed: ${e}`);
    dbgError("illegal", `Illegal stack enforcement error: ${e}`);
  }
}

system.runInterval(() => {
  try {
    const players = getPlayersSafe();
    for (const p of players) enforceIllegalStacksForPlayer(p);
  } catch (e) {
    dbgError("illegal", `Illegal stack interval crashed: ${e}`);
  }
}, ILLEGAL_STACK_SCAN_TICKS);

// --- Scanner ---
function* mainScanner() {
  dbgInfo("scanner", "Scanner started.");

  while (true) {
    const players = getPlayersSafe();

    if (!configLoaded) loadGlobalConfig();

    const scanAny = !!(globalConfig.plantPatch || globalConfig.hopperPatch || globalConfig.dropperPatch);
    if (!scanAny) {
    dbgOncePer("scanner_disabled", 600, "info", "scanner", "Scanner loop active, but all scan patches are disabled.");
      yield "FRAME_END";
      continue;
    }

    for (const player of players) {
      try {
        if (!player?.location) continue;

        const dim = player.dimension;
        const { x: cx, y: cy, z: cz } = player.location;
        const bx = Math.floor(cx);
        const by = Math.floor(cy);
        const bz = Math.floor(cz);

        const checkPlant   = !!globalConfig.plantPatch;
        const checkHopper  = !!globalConfig.hopperPatch;
        const checkDropper = !!globalConfig.dropperPatch;
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
        dbgError("scanner", `Scanner crashed on a player loop: ${e}`);
      }
    }
    yield "FRAME_END";
  }
}

const scanner = mainScanner();

system.runInterval(() => {
  try {
    let ops = 0;
    let result;

    while (ops < BLOCKS_PER_TICK_LIMIT) {
      result = scanner.next();
      ops++;
      if (result?.value === "FRAME_END") break;
    }
  } catch (e) {
    dbgError("scanner", `Scanner interval crashed: ${e}`);
  }
}, 1);

// --- Patch Handlers ---
function processPlantCheck(player, dim, plantBlock, pos) {
  // USER-FACING TYPE: "Piston Dupe"
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
          dbgWarn("plant", `Removed piston near two-high plant @ ${bx},${pos.y},${bz}`);

          alertDupe(
            player,
            "Piston Dupe",
            plantBlock.typeId,
            pos,
            "Nearby piston removed."
          );
        } else {
          dbgError("plant", `Unable to remove piston @ ${bx},${pos.y},${bz}`);
        }
      }
    }
  }
}

function processHopperCheck(player, block, pos) {
  // USER-FACING TYPE: "Hopper Dupe"
  const inv =
    block.getComponent?.("minecraft:inventory") ??
    block.getComponent?.("inventory");
  const cont = inv?.container;
  if (!cont) {
    dbgOncePer("hopper_no_container", 600, "warn", "hopper", "Hopper scan: missing inventory container component.");
    return;
  }

  if (!restrictedItemsSet || restrictedItemsSet.size === 0) {
    dbgOncePer("hopper_no_restrict", 600, "warn", "hopper", "Restricted item list is empty; hopper patch is inactive.");
    return;
  }

  let wiped = false;
  const removed = [];

  for (let slot = 0; slot < cont.size; slot++) {
    const stack = cont.getItem(slot);
    if (!stack) continue;

    if (restrictedItemsSet.has(String(stack.typeId).toLowerCase())) {
      removed.push(`${stack.amount}x ${stack.typeId}`);
      clearContainerSlot(cont, slot);
      wiped = true;
    }
  }

  if (wiped) {
    dbgWarn("hopper", `Restricted item(s) removed from hopper: ${removed.join(", ") || "unknown"}`);
    alertDupe(
      player,
      "Hopper Dupe",
      removed.length ? removed.join(", ") : "Restricted Item",
      pos,
      "Restricted item removed from hopper inventory."
    );
  }
}

function processDropperCheck(player, dim, block, pos) {
  // USER-FACING TYPE: "Dropper Dupe" with NOTE: (Item Ejected)
  const inv =
    block.getComponent?.("minecraft:inventory") ??
    block.getComponent?.("inventory");
  const cont = inv?.container;
  if (!cont) {
    dbgOncePer("dropper_no_container", 600, "warn", "dropper", "Dropper scan: missing inventory container component.");
    return;
  }

  if (!restrictedItemsSet || restrictedItemsSet.size === 0) {
    dbgOncePer("dropper_no_restrict", 600, "warn", "dropper", "Restricted item list is empty; dropper patch is inactive.");
    return;
  }

  let wiped = false;
  const removed = [];

  for (let slot = 0; slot < cont.size; slot++) {
    const stack = cont.getItem(slot);
    if (!stack) continue;

    if (restrictedItemsSet.has(String(stack.typeId).toLowerCase())) {
      removed.push(`${stack.amount}x ${stack.typeId}`);

      try {
        dim.spawnItem(stack, { x: pos.x + 0.5, y: pos.y + 1.2, z: pos.z + 0.5 });
      } catch (e) {
        dbgWarn("dropper", `spawnItem error during ejection: ${e}`);
      }

      clearContainerSlot(cont, slot);
      wiped = true;
    }
  }

  if (wiped) {
    dbgWarn("dropper", `Restricted item(s) ejected from dropper: ${removed.join(", ") || "unknown"}`);
    alertDupe(
      player,
      "Dropper Dupe",
      removed.length ? removed.join(", ") : "Restricted Item",
      pos,
      "Restricted item ejected and removed from dropper inventory.",
      "(Item Ejected)"
    );
  }
}

// --- UI Handling ---
async function ForceOpen(player, form, timeout = 1200) {
  try {
    const start = system.currentTick;
    while (system.currentTick - start < timeout) {
      const response = await form.show(player);
      if (response.cancelationReason !== "UserBusy") return response;
      await new Promise((resolve) => {
        try {
          if (typeof system.runTimeout === "function") {
            system.runTimeout(resolve, 2);
          } else {
            system.run(resolve);
          }
        } catch {
          system.run(resolve);
        }
      });
    }
    dbgWarn("ui", "ForceOpen timed out (player remained busy).");
    console.warn("[Anti-Dupe] ForceOpen timed out (player remained busy).");
    return undefined;
  } catch (e) {
    dbgError("ui", `ForceOpen error: ${e}`);
    console.warn(`[Anti-Dupe] ForceOpen error: ${e}`);
    return undefined;
  }
}

// --- Logs UI ---
function openLogsMenu(player) {
  dbgInfo("ui", "Opened Logs Menu.");

  const form = new ActionFormData()
    .title("Logs")
    .button("Incident Logs")
    .button("Violations")
    .button("Back");

  ForceOpen(player, form).then((res) => {
    if (!res) {
      notifyFormFailed(player, "Logs Menu");
      return openNextTick(() => openMainMenu(player));
    }
    if (res.canceled) return openNextTick(() => openMainMenu(player));
    if (res.selection === 0) openNextTick(() => openIncidentLogsMenu(player));
    else if (res.selection === 1) openNextTick(() => openViolationsDashboard(player));
    else openNextTick(() => openMainMenu(player));
  }).catch((e) => {
    dbgError("ui", `Logs menu submit failed: ${e}`);
    console.warn(`[Anti-Dupe] Logs menu submit failed: ${e}`);
    notifyFormFailed(player, "Logs Menu");
    openNextTick(() => openMainMenu(player));
  });
}

// Incident Logs submenu (Clear lives HERE)
function openIncidentLogsMenu(player) {
  const total = dupeLogs.length;
  const recent = getMostRecentIncidentSummary();

  dbgInfo("ui", "Opened Incident Logs Menu.");

  const form = new ActionFormData()
    .title("Incident Logs")
    .body(`Total Incidents: ${total}\nMost Recent: ${recent}`)
    .button("View Logs")
    .button("Clear Logs")
    .button("Back");

  ForceOpen(player, form).then((res) => {
    if (!res) {
      notifyFormFailed(player, "Incident Logs Menu");
      return openNextTick(() => openLogsMenu(player));
    }
    if (res.canceled) return openNextTick(() => openLogsMenu(player));

    if (res.selection === 0) openNextTick(() => openIncidentLogViewer(player));
    else if (res.selection === 1) openNextTick(() => confirmClearIncidentLogs(player));
    else openNextTick(() => openLogsMenu(player));
  }).catch((e) => {
    dbgError("ui", `Incident logs menu submit failed: ${e}`);
    console.warn(`[Anti-Dupe] Incident logs menu submit failed: ${e}`);
    notifyFormFailed(player, "Incident Logs Menu");
    openNextTick(() => openLogsMenu(player));
  });
}

function openIncidentLogViewer(player) {
  dbgInfo("ui", "Opened Incident Log Viewer.");

  const bodyText = formatIncidentLogsText(25);

  const form = new MessageFormData()
    .title("Incident Logs")
    .body(bodyText)
    .button1("Close")
    .button2("Back");

  ForceOpen(player, form).then((res) => {
    if (!res) {
      notifyFormFailed(player, "Incident Logs Viewer");
      return openNextTick(() => openIncidentLogsMenu(player));
    }
    if (res.canceled) return openNextTick(() => openIncidentLogsMenu(player));
    if (res.selection === 1) openNextTick(() => openIncidentLogsMenu(player));
  }).catch((e) => {
    dbgError("ui", `Incident logs viewer submit failed: ${e}`);
    console.warn(`[Anti-Dupe] Incident logs viewer submit failed: ${e}`);
    notifyFormFailed(player, "Incident Logs Viewer");
    openNextTick(() => openIncidentLogsMenu(player));
  });
}

function confirmClearIncidentLogs(player) {
  dbgWarn("ui", "Opened Clear Incident Logs Confirmation.");

  const form = new MessageFormData()
    .title("Clear Incident Logs")
    .body("This will permanently delete all incident log entries.\n\nProceed?")
    .button1("Cancel")
    .button2("Clear");

  ForceOpen(player, form).then((res) => {
    if (!res) {
      notifyFormFailed(player, "Clear Incident Logs");
      return openNextTick(() => openIncidentLogsMenu(player));
    }
    if (res.canceled) return openNextTick(() => openIncidentLogsMenu(player));
    if (res.selection === 1) {
      dupeLogs = [];
      queueSaveLogs();
      try { player.sendMessage("§aIncident Logs Cleared."); } catch {}
      dbgWarn("logs", "Incident logs cleared by admin.");
    }
    openNextTick(() => openIncidentLogsMenu(player));
  }).catch((e) => {
    dbgError("ui", `Clear incident logs submit failed: ${e}`);
    console.warn(`[Anti-Dupe] Clear incident logs submit failed: ${e}`);
    notifyFormFailed(player, "Clear Incident Logs");
    openNextTick(() => openIncidentLogsMenu(player));
  });
}

// --- Violations UI ---
function openViolationsDashboard(player) {
  if (!vioStatsLoaded) loadVioStats();
  ensureViolationObjectives();

  dbgInfo("ui", "Opened Violations Dashboard.");

  const { key: mostKey, count: mostCount } = getMostUsedViolationType();
  const mr = vioStats?.mostRecent ?? { t: "", player: "", type: "" };
  const mrTime = mr.t ? formatIsoUtcSplit(mr.t).combined : "";

  const globalCount = Number.isFinite(vioStats.globalCount) ? vioStats.globalCount : 0;
  const { rows, note } = getViolationsTable();

  const lines = [];
  lines.push("§lViolation Dashboard§r");
  lines.push("");
  lines.push(`§7Global Violation Count:§r §e${globalCount}§r`);
  lines.push(`§7Most Recent Violation:§r ${mr.player ? `§f${mr.player}§r §7—§r §f${mr.type}§r${mrTime ? ` §7@§r §f${mrTime}§r` : ""}` : "§8None§r"}`);
  lines.push(`§7Most Used Violation:§r ${mostKey !== "None" ? `§f${prettyTypeKey(mostKey)}§r §7(${mostCount})§r` : "§8None§r"}`);
  lines.push("");

  const tc = vioStats.typeCounts ?? {};
  lines.push("§lType Totals§r");
  lines.push(`§7Ghost:§r ${tc.ghost ?? 0}  §7Piston:§r ${tc.plant ?? 0}  §7Hopper:§r ${tc.hopper ?? 0}  §7Dropper:§r ${tc.dropper ?? 0}  §7Illegal:§r ${tc.illegal ?? 0}  §7Other:§r ${tc.other ?? 0}`);
  lines.push("");

  if (note) {
    lines.push(`§8${note}§r`);
    lines.push("");
  }

  lines.push("§lPlayers with Violations§r");
  if (!rows.length) {
    lines.push("§8None§r");
  } else {
    const cap = 40;
    const shown = rows.slice(0, cap);
    let idx = 1;

    for (const r of shown) {
      lines.push(
        `${idx}) §f${r.name}§r — §e${r.total}§r ` +
        `§7(G:${r.ghost} P:${r.plant} H:${r.hopper} D:${r.dropper} I:${r.illegal} O:${r.other})§r`
      );
      idx++;
    }

    if (rows.length > cap) {
      lines.push("");
      lines.push(`§8...and ${rows.length - cap} more§r`);
    }
  }

  const form = new MessageFormData()
    .title("Violations")
    .body(lines.join("\n"))
    .button1("Close")
    .button2("Refresh");

  ForceOpen(player, form).then((res) => {
    if (!res) {
      notifyFormFailed(player, "Violations Dashboard");
      return openNextTick(() => openLogsMenu(player));
    }
    if (res.canceled) return openNextTick(() => openLogsMenu(player));
    if (res.selection === 1) openNextTick(() => openViolationsDashboard(player));
  }).catch((e) => {
    dbgError("ui", `Violations dashboard submit failed: ${e}`);
    console.warn(`[Anti-Dupe] Violations dashboard submit failed: ${e}`);
    notifyFormFailed(player, "Violations Dashboard");
    openNextTick(() => openLogsMenu(player));
  });
}

// --- Settings UI ---
function openSettingsMenu(player) {
  dbgInfo("ui", "Opened Settings Menu.");

  const form = new ActionFormData()
    .title("Settings")
    .button("Configuration")
    .button("Restricted Items")
    .button("Personal Settings")
    .button("Back");

  ForceOpen(player, form).then((res) => {
    if (!res) {
      notifyFormFailed(player, "Settings Menu");
      return openNextTick(() => openMainMenu(player));
    }
    if (res.canceled) return openNextTick(() => openMainMenu(player));
    if (res.selection === 0) openNextTick(() => openConfigurationForm(player));
    else if (res.selection === 1) openNextTick(() => openRestrictedItemsMenu(player));
    else if (res.selection === 2) openNextTick(() => openPersonalSettingsForm(player));
    else openNextTick(() => openMainMenu(player));
  }).catch((e) => {
    dbgError("ui", `Settings menu submit failed: ${e}`);
    console.warn(`[Anti-Dupe] Settings menu submit failed: ${e}`);
    notifyFormFailed(player, "Settings Menu");
    openNextTick(() => openMainMenu(player));
  });
}

// --- Punishments UI ---
function getPunishmentSummaryLines() {
  if (!configLoaded) loadGlobalConfig();
  const punish = globalConfig.punishments;

  const status = punish?.enabled ? "Enabled" : "Disabled";
  const kickStatus = punish?.allowKick ? "Allowed" : "Not Allowed";
  const bypass = punish?.bypassTag ? punish.bypassTag : "None";

  return [
    `Status: ${status}`,
    `Kick Actions: ${kickStatus}`,
    `Bypass Tag: ${bypass}`,
  ];
}

function openPunishmentsMenu(player) {
  try {
    if (!configLoaded) loadGlobalConfig();
    dbgInfo("ui", "Opened Punishments Menu.");

    const form = new ActionFormData()
      .title("Punishments")
      .body(getPunishmentSummaryLines().join("\n"))
      .button("Global Options")
      .button("Configure Dupe Types")
      .button("Violations")
      .button("Back");

    ForceOpen(player, form)
      .then((res) => {
        if (!res) {
          notifyFormFailed(player, "Punishments Menu");
          return openNextTick(() => openMainMenu(player));
        }
        if (res.canceled) return openNextTick(() => openMainMenu(player));
        if (res.selection === 0) openNextTick(() => openPunishmentGlobalOptionsHub(player));
        else if (res.selection === 1) openNextTick(() => openPunishmentTypeMenu(player));
        else if (res.selection === 2) openNextTick(() => openViolationsMenu(player));
        else openNextTick(() => openMainMenu(player));
      })
      .catch((e) => {
        dbgError("ui", `Punishments menu failed: ${e}`);
        logConsoleWarn(`[Anti-Dupe] Punishments menu failed: ${e}`);
        notifyFormFailed(player, "Punishments Menu");
        openNextTick(() => openMainMenu(player));
      });
  } catch (e) {
    dbgError("ui", `Punishments menu build failed: ${e}`);
    logConsoleWarn(`[Anti-Dupe] Punishments menu build failed: ${e}`);
    notifyFormFailed(player, "Punishments Menu");
    openNextTick(() => openMainMenu(player));
  }
}

function openPunishmentGlobalOptionsHub(player) {
  try {
    if (!configLoaded) loadGlobalConfig();
    dbgInfo("ui", "Opened Global Punishment Options Hub.");

    const punish = globalConfig.punishments ?? {};
    const status = punish.enabled ? "Enabled" : "Disabled";
    const kickStatus = punish.allowKick ? "Allowed" : "Disabled";
    const bypass = punish.bypassTag ? punish.bypassTag : "None";
    const cooldown = clampRangeInt(punish.cooldownTicks, 0, 200, 20);
    const publicKick = punish.publicKickMessage ? "On" : "Off";

    const form = new ActionFormData()
      .title("Global Punishment Options")
      .body(
        [
          `Status: ${status}`,
          `Kick Actions: ${kickStatus} (Cooldown: ${cooldown} ticks)`,
          `Bypass Tag: ${bypass}`,
          `Public Kick Message: ${publicKick}`,
        ].join("\n")
      )
      .button("Edit Settings")
      .button("Reason Template Help")
      .button("Reset Reason Template to Default")
      .button("Back");

    ForceOpen(player, form).then((res) => {
      if (!res) {
        notifyFormFailed(player, "Global Punishment Options");
        return openNextTick(() => openPunishmentsMenu(player));
      }
      if (res.canceled) return openNextTick(() => openPunishmentsMenu(player));
      if (res.selection === 0) openNextTick(() => openPunishmentGlobalOptionsForm(player));
      else if (res.selection === 1) openNextTick(() => openPunishmentKickTemplateHelp(player));
      else if (res.selection === 2) {
        globalConfig = normalizeConfig({
          ...globalConfig,
          punishments: {
            ...globalConfig.punishments,
            reasonTemplate: DEFAULT_GLOBAL_CONFIG.punishments.reasonTemplate,
          },
        });
        queueSaveGlobalConfig();
        try { player.sendMessage("§aReason template reset to default."); } catch {}
        openNextTick(() => openPunishmentGlobalOptionsHub(player));
      }
      else openNextTick(() => openPunishmentsMenu(player));
    }).catch((e) => {
      dbgError("ui", `Global punishment options hub failed: ${e}`);
      logConsoleWarn(`[Anti-Dupe] Global punishment options hub failed: ${e}`);
      notifyFormFailed(player, "Global Punishment Options");
      openNextTick(() => openPunishmentsMenu(player));
    });
  } catch (e) {
    dbgError("ui", `Global punishment options hub build failed: ${e}`);
    logConsoleWarn(`[Anti-Dupe] Global punishment options hub build failed: ${e}`);
    notifyFormFailed(player, "Global Punishment Options");
    openNextTick(() => openPunishmentsMenu(player));
  }
}

function openPunishmentKickTemplateHelp(player) {
  try {
    dbgInfo("ui", "Opened Kick Reason Template Help.");

    const body = [
      "Kick reason templates are used in kick messages.",
      "",
      "Tokens:",
      "{TYPE} = dupe type label (Ghost Stack, Hopper, etc.)",
      "{COUNT} = player's current violation count for this type",
      "{THRESHOLD} = configured threshold for this type",
      "",
      "Examples:",
      "Anti-Dupe: {TYPE} ({COUNT}/{THRESHOLD})",
      "{TYPE} dupe detected: {COUNT}/{THRESHOLD}",
      "",
      "Note: Very long messages may be truncated by UI or command limits.",
    ].join("\n");

    const form = new MessageFormData()
      .title("Kick Reason Template Help")
      .body(body)
      .button1("Back")
      .button2("Edit Settings");

    ForceOpen(player, form).then((res) => {
      if (!res) {
        notifyFormFailed(player, "Kick Reason Template Help");
        return openNextTick(() => openPunishmentGlobalOptionsHub(player));
      }
      if (res.canceled) return openNextTick(() => openPunishmentGlobalOptionsHub(player));
      if (res.selection === 1) openNextTick(() => openPunishmentGlobalOptionsForm(player));
      else openNextTick(() => openPunishmentGlobalOptionsHub(player));
    }).catch((e) => {
      dbgError("ui", `Kick Reason Template help failed: ${e}`);
      logConsoleWarn(`[Anti-Dupe] Kick Reason Template help failed: ${e}`);
      notifyFormFailed(player, "Kick Reason Template Help");
      openNextTick(() => openPunishmentGlobalOptionsHub(player));
    });
  } catch (e) {
    dbgError("ui", `Kick Reason Template help build failed: ${e}`);
    logConsoleWarn(`[Anti-Dupe] Kick Reason Template help build failed: ${e}`);
    notifyFormFailed(player, "Kick Reason Template Help");
    openNextTick(() => openPunishmentGlobalOptionsHub(player));
  }
}

function getViolationScoresForName(nameKey) {
  const scores = {
    total: { score: 0, found: false },
    ghost: { score: 0, found: false },
    plant: { score: 0, found: false },
    hopper: { score: 0, found: false },
    dropper: { score: 0, found: false },
    illegal: { score: 0, found: false },
    other: { score: 0, found: false },
  };

  if (!ensureViolationObjectives()) return { scores, foundAny: false };
  const sb = world.scoreboard;
  if (!sb) return { scores, foundAny: false };

  const totalObj = sb.getObjective(VIO_OBJ_TOTAL);
  const ghostObj = sb.getObjective(VIO_OBJ_GHOST);
  const plantObj = sb.getObjective(VIO_OBJ_PLANT);
  const hopperObj = sb.getObjective(VIO_OBJ_HOPPER);
  const dropperObj = sb.getObjective(VIO_OBJ_DROPPER);
  const illegalObj = sb.getObjective(VIO_OBJ_ILLEGAL);
  const otherObj = sb.getObjective(VIO_OBJ_OTHER);

  const total = readScoreForName(totalObj, nameKey);
  const ghost = readScoreForName(ghostObj, nameKey);
  const plant = readScoreForName(plantObj, nameKey);
  const hopper = readScoreForName(hopperObj, nameKey);
  const dropper = readScoreForName(dropperObj, nameKey);
  const illegal = readScoreForName(illegalObj, nameKey);
  const other = readScoreForName(otherObj, nameKey);

  scores.total = { score: total.score, found: total.found };
  scores.ghost = { score: ghost.score, found: ghost.found };
  scores.plant = { score: plant.score, found: plant.found };
  scores.hopper = { score: hopper.score, found: hopper.found };
  scores.dropper = { score: dropper.score, found: dropper.found };
  scores.illegal = { score: illegal.score, found: illegal.found };
  scores.other = { score: other.score, found: other.found };

  const foundAny = Object.values(scores).some((v) => v.found);
  return { scores, foundAny };
}

function resetViolationScoresByName(nameKey, typeKey, resetTotal) {
  if (!ensureViolationObjectives()) return { found: false, results: [] };
  const sb = world.scoreboard;
  if (!sb) return { found: false, results: [] };

  const objectives = [];
  if (typeKey === "all") {
    objectives.push(VIO_OBJ_GHOST, VIO_OBJ_PLANT, VIO_OBJ_HOPPER, VIO_OBJ_DROPPER, VIO_OBJ_ILLEGAL, VIO_OBJ_OTHER);
    if (resetTotal) objectives.push(VIO_OBJ_TOTAL);
  } else if (typeKey === "total") {
    objectives.push(VIO_OBJ_TOTAL);
  } else {
    objectives.push(objectiveIdForKey(typeKey));
    if (resetTotal) objectives.push(VIO_OBJ_TOTAL);
  }

  let foundAny = false;
  const results = [];
  for (const objId of objectives) {
    const obj = sb.getObjective(objId);
    if (!obj) continue;
    const res = resetScore(obj, nameKey);
    results.push({ objId, ...res });
    if (res.found) foundAny = true;
  }
  return { found: foundAny, results };
}

function openViolationResetStart(player) {
  try {
    dbgInfo("ui", "Opened Violation Reset Start.");

    const form = new ModalFormData().title("Violation Resets");
    addTextFieldCompat(form, "Player Name", "playerName", "");
    addToggleCompat(form, "Reset All Types", false);
    addToggleCompat(form, "Reset Total Score", true);

    ForceOpen(player, form).then((res) => {
      if (!res) {
        notifyFormFailed(player, "Violation Resets");
        return openNextTick(() => openPunishmentsMenu(player));
      }
      if (res.canceled) return openNextTick(() => openPunishmentsMenu(player));
      const v = res.formValues ?? [];
      const nameKey = String(v[0] ?? "").trim();
      const resetAll = !!v[1];
      const resetTotal = !!v[2];
      if (!nameKey) {
        try { player.sendMessage("§cEnter a player name to reset."); } catch {}
        return openNextTick(() => openViolationResetStart(player));
      }
      if (resetAll) {
        return openNextTick(() => openViolationResetConfirm(player, nameKey, "all", resetTotal));
      }
      openNextTick(() => openViolationResetTypeMenu(player, nameKey, resetTotal));
    }).catch((e) => {
      dbgError("ui", `Violation reset start failed: ${e}`);
      logConsoleWarn(`[Anti-Dupe] Violation reset start failed: ${e}`);
      notifyFormFailed(player, "Violation Resets");
      openNextTick(() => openPunishmentsMenu(player));
    });
  } catch (e) {
    dbgError("ui", `Violation reset start build failed: ${e}`);
    logConsoleWarn(`[Anti-Dupe] Violation reset start build failed: ${e}`);
    notifyFormFailed(player, "Violation Resets");
    openNextTick(() => openPunishmentsMenu(player));
  }
}

function openViolationResetTypeMenu(player, nameKey, resetTotal) {
  try {
    dbgInfo("ui", `Opened Violation Reset Type Menu for ${nameKey}.`);
    const form = new ActionFormData()
      .title("Select Violation Type")
      .body(`Player: ${nameKey}`)
      .button("Ghost Stack")
      .button("Piston")
      .button("Hopper")
      .button("Dropper")
      .button("Illegal Stack")
      .button("Other")
      .button("Total Only")
      .button("Back");

    ForceOpen(player, form).then((res) => {
      if (!res) {
        notifyFormFailed(player, "Violation Reset Type");
        return openNextTick(() => openViolationResetStart(player));
      }
      if (res.canceled) return openNextTick(() => openViolationResetStart(player));
      if (res.selection === 0) openNextTick(() => openViolationResetConfirm(player, nameKey, "ghost", resetTotal));
      else if (res.selection === 1) openNextTick(() => openViolationResetConfirm(player, nameKey, "plant", resetTotal));
      else if (res.selection === 2) openNextTick(() => openViolationResetConfirm(player, nameKey, "hopper", resetTotal));
      else if (res.selection === 3) openNextTick(() => openViolationResetConfirm(player, nameKey, "dropper", resetTotal));
      else if (res.selection === 4) openNextTick(() => openViolationResetConfirm(player, nameKey, "illegal", resetTotal));
      else if (res.selection === 5) openNextTick(() => openViolationResetConfirm(player, nameKey, "other", resetTotal));
      else if (res.selection === 6) openNextTick(() => openViolationResetConfirm(player, nameKey, "total", true));
      else openNextTick(() => openViolationResetStart(player));
    }).catch((e) => {
      dbgError("ui", `Violation reset type menu failed: ${e}`);
      logConsoleWarn(`[Anti-Dupe] Violation reset type menu failed: ${e}`);
      notifyFormFailed(player, "Violation Reset Type");
      openNextTick(() => openViolationResetStart(player));
    });
  } catch (e) {
    dbgError("ui", `Violation reset type menu build failed: ${e}`);
    logConsoleWarn(`[Anti-Dupe] Violation reset type menu build failed: ${e}`);
    notifyFormFailed(player, "Violation Reset Type");
    openNextTick(() => openViolationResetStart(player));
  }
}

function openViolationResetConfirm(player, nameKey, typeKey, resetTotal) {
  try {
    dbgInfo("ui", `Opened Violation Reset Confirm for ${nameKey}.`);
    const { scores, foundAny } = getViolationScoresForName(nameKey);
    if (!foundAny) {
      try { player.sendMessage("§eNo scores found for that player."); } catch {}
      return openNextTick(() => openViolationResetStart(player));
    }

    const lines = [];
    const targetLabel = typeKey === "all"
      ? "All Types"
      : (typeKey === "total" ? "Total Only" : prettyTypeKey(typeKey));

    lines.push(`Player: ${nameKey}`);
    lines.push(`Action: Reset ${targetLabel}${resetTotal && typeKey !== "total" ? " + Total" : ""}`);
    lines.push("");
    lines.push("Current Scores:");

    if (typeKey === "all") {
      lines.push(`Total: ${scores.total.score}`);
      lines.push(`Ghost: ${scores.ghost.score}`);
      lines.push(`Piston: ${scores.plant.score}`);
      lines.push(`Hopper: ${scores.hopper.score}`);
      lines.push(`Dropper: ${scores.dropper.score}`);
      lines.push(`Illegal: ${scores.illegal.score}`);
      lines.push(`Other: ${scores.other.score}`);
    } else if (typeKey === "total") {
      lines.push(`Total: ${scores.total.score}`);
    } else {
      const keyMap = {
        ghost: scores.ghost,
        plant: scores.plant,
        hopper: scores.hopper,
        dropper: scores.dropper,
        illegal: scores.illegal,
        other: scores.other,
      };
      const entry = keyMap[typeKey];
      lines.push(`${prettyTypeKey(typeKey)}: ${entry?.score ?? 0}`);
      if (resetTotal) lines.push(`Total: ${scores.total.score}`);
    }

    const form = new MessageFormData()
      .title("Confirm Violation Reset")
      .body(lines.join("\n"))
      .button1("Confirm")
      .button2("Cancel");

    ForceOpen(player, form).then((res) => {
      if (!res) {
        notifyFormFailed(player, "Violation Reset Confirm");
        return openNextTick(() => openViolationResetStart(player));
      }
      if (res.canceled || res.selection === 1) return openNextTick(() => openViolationResetStart(player));
      const result = resetViolationScoresByName(nameKey, typeKey, resetTotal);
      if (!result.found) {
        try { player.sendMessage("§eNo scores found for that player/type."); } catch {}
        return openNextTick(() => openViolationResetStart(player));
      }
      try { player.sendMessage(`§aViolation scores reset for ${nameKey}.`); } catch {}
      openNextTick(() => openViolationResetStart(player));
    }).catch((e) => {
      dbgError("ui", `Violation reset confirm failed: ${e}`);
      logConsoleWarn(`[Anti-Dupe] Violation reset confirm failed: ${e}`);
      notifyFormFailed(player, "Violation Reset Confirm");
      openNextTick(() => openViolationResetStart(player));
    });
  } catch (e) {
    dbgError("ui", `Violation reset confirm build failed: ${e}`);
    logConsoleWarn(`[Anti-Dupe] Violation reset confirm build failed: ${e}`);
    notifyFormFailed(player, "Violation Reset Confirm");
    openNextTick(() => openViolationResetStart(player));
  }
}

function buildViolationEntries(filter = "all") {
  if (!violationsDbLoaded) loadViolationsDb();
  ensureViolationObjectives();
  const entries = new Map();
  const profiles = violationsDb.profiles ?? {};

  for (const [key, rec] of Object.entries(profiles)) {
    if (!key) continue;
    const kickLoopEnabled = !!rec?.kickLoop?.enabled;
    if (filter === "kickLoopOnly" && !kickLoopEnabled) continue;
    entries.set(key, {
      key,
      name: rec?.name ?? "Unknown",
      violations: Number.isFinite(rec?.violations) ? rec.violations : 0,
      lastViolationAt: Number.isFinite(rec?.lastViolationAt) ? rec.lastViolationAt : 0,
      reason: rec?.reason ?? "",
      kickLoop: rec?.kickLoop ?? { enabled: false },
      lastSeenMs: Number.isFinite(rec?.lastSeenMs) ? rec.lastSeenMs : 0,
      lastKnown: rec?.lastKnown ?? null,
      lastKnownSource: rec?.lastKnownSource ?? "",
    });
  }

  try {
    const sb = world.scoreboard;
    const totalObj = sb?.getObjective?.(VIO_OBJ_TOTAL);
    const scores = totalObj?.getScores?.() ?? [];
    let didUpdate = false;
    for (const s of scores) {
      const participant = s?.participant;
      const name = participant?.displayName ?? "";
      if (!name || name === GLOBAL_PARTICIPANT) continue;
      if (isBadOfflineScoreboardName(name)) continue;
      const total = s?.score ?? 0;
      if (total <= 0) continue;
      const key = normalizeViolationKey(name);
      if (!key) continue;
      if (!entries.has(key)) {
        if (filter === "kickLoopOnly") continue;
        const profile = normalizeViolationProfile({}, name);
        profile.violations = total;
        profiles[key] = profile;
        entries.set(key, {
          key,
          name,
          violations: total,
          lastViolationAt: 0,
          reason: "",
          kickLoop: { enabled: false },
          lastSeenMs: 0,
          lastKnown: null,
          lastKnownSource: "",
        });
        didUpdate = true;
      } else {
        const current = entries.get(key);
        if (current && total > current.violations) {
          current.violations = total;
          const existing = profiles[key] ?? normalizeViolationProfile({}, name);
          profiles[key] = { ...existing, name, violations: total };
          didUpdate = true;
        }
      }
    }
    if (didUpdate) {
      violationsDb.profiles = profiles;
      queueSaveViolationsDb();
    }
  } catch (e) {
    dbgWarn("violators", `Unable to read violator scores: ${e}`);
  }

  const list = Array.from(entries.values());
  list.sort((a, b) => {
    const aSeen = a.lastSeenMs || 0;
    const bSeen = b.lastSeenMs || 0;
    if (bSeen !== aSeen) return bSeen - aSeen;
    return (a.name || "").localeCompare(b.name || "");
  });

  return list;
}

function openViolationsMenu(player) {
  try {
    dbgInfo("ui", "Opened Violations Menu.");
    const body = [
      "Review and manage player violations and enforcement state.",
      "View detailed records (including last known location when available) and take actions.",
      "Violation Resets: adjust scoreboard counts for a named player.",
    ].join("\n");

    const form = new ActionFormData()
      .title("Violations")
      .body(body)
      .button("Violation Resets")
      .button("Violation List")
      .button("Kick-Looped Violations")
      .button("Back");

    ForceOpen(player, form).then((res) => {
      if (!res) {
        notifyFormFailed(player, "Violations Menu");
        return openNextTick(() => openPunishmentsMenu(player));
      }
      if (res.canceled) return openNextTick(() => openPunishmentsMenu(player));
      if (res.selection === 0) openNextTick(() => openViolationResetStart(player));
      else if (res.selection === 1) openNextTick(() => openViolationList(player, "all", 0));
      else if (res.selection === 2) openNextTick(() => openViolationList(player, "kickLoopOnly", 0));
      else openNextTick(() => openPunishmentsMenu(player));
    }).catch((e) => {
      dbgError("ui", `Violations menu submit failed: ${e}`);
      logConsoleWarn(`[Anti-Dupe] Violations menu submit failed: ${e}`);
      notifyFormFailed(player, "Violations Menu");
      openNextTick(() => openPunishmentsMenu(player));
    });
  } catch (e) {
    dbgError("ui", `Violations menu build failed: ${e}`);
    logConsoleWarn(`[Anti-Dupe] Violations menu build failed: ${e}`);
    notifyFormFailed(player, "Violations Menu");
    openNextTick(() => openPunishmentsMenu(player));
  }
}

function openViolationList(player, filter = "all", pageIndex = 0) {
  try {
    dbgInfo("ui", `Opened Violations List (${filter}) page ${pageIndex}.`);
    if (!configLoaded) loadGlobalConfig();
    const pageSize = 12;
    const entries = buildViolationEntries(filter);
    if (!entries.length) {
      const empty = new ActionFormData()
        .title("Violations")
        .body("No violations were found for this filter.")
        .button("Back");
      return ForceOpen(player, empty).then((res) => {
        if (!res) {
          notifyFormFailed(player, "Violations List");
          return openNextTick(() => openViolationsMenu(player));
        }
        openNextTick(() => openViolationsMenu(player));
      }).catch((e) => {
        dbgError("ui", `Violations list empty submit failed: ${e}`);
        logConsoleWarn(`[Anti-Dupe] Violations list empty submit failed: ${e}`);
        notifyFormFailed(player, "Violations List");
        openNextTick(() => openViolationsMenu(player));
      });
    }

    const start = pageIndex * pageSize;
    const page = entries.slice(start, start + pageSize);
    const tracking = globalConfig.tracking ?? DEFAULT_GLOBAL_CONFIG.tracking;
    const intervalSec = clampRangeInt(tracking.updateIntervalSeconds, 1, 600, 10);
    const trackingLabel = tracking.enabled ? `${intervalSec}s` : "Off";

    const form = new ActionFormData()
      .title("Violations")
      .body(
        [
          `Showing ${start + 1}-${Math.min(start + page.length, entries.length)} of ${entries.length}`,
          `Entries: ${entries.length}`,
          `Tracking interval: ${trackingLabel}`,
        ].join("\n")
      );

    for (const entry of page) {
      const lastSeen = entry.lastSeenMs ? formatAgo(entry.lastSeenMs) : "Unknown";
      form.button(`§f${entry.name}\n§7Last seen: ${lastSeen}`);
    }

    if (pageIndex > 0) form.button("← Prev Page");
    if (start + page.length < entries.length) form.button("Next Page →");
    form.button("Back");
    const canClearAll = player?.hasTag?.(ADMIN_TAG);
    if (canClearAll) form.button("Clear All Violations");

    ForceOpen(player, form).then((res) => {
      if (!res) {
        notifyFormFailed(player, "Violations List");
        return openNextTick(() => openViolationsMenu(player));
      }
      if (res.canceled) return openNextTick(() => openViolationsMenu(player));

      const selection = res.selection ?? -1;
      if (selection >= 0 && selection < page.length) {
        const entry = page[selection];
        return openNextTick(() => openViolationDetail(player, entry, filter, pageIndex));
      }

      let index = page.length;
      if (pageIndex > 0) {
        if (selection === index) return openNextTick(() => openViolationList(player, filter, pageIndex - 1));
        index += 1;
      }
      if (start + page.length < entries.length) {
        if (selection === index) return openNextTick(() => openViolationList(player, filter, pageIndex + 1));
        index += 1;
      }
      if (selection === index) return openNextTick(() => openViolationsMenu(player));
      index += 1;
      if (canClearAll && selection === index) {
        return openNextTick(() => confirmClearAllViolations(player, filter, pageIndex));
      }
      openNextTick(() => openViolationsMenu(player));
    }).catch((e) => {
      dbgError("ui", `Violations list submit failed: ${e}`);
      logConsoleWarn(`[Anti-Dupe] Violations list submit failed: ${e}`);
      notifyFormFailed(player, "Violations List");
      openNextTick(() => openViolationsMenu(player));
    });
  } catch (e) {
    dbgError("ui", `Violations list build failed: ${e}`);
    logConsoleWarn(`[Anti-Dupe] Violations list build failed: ${e}`);
    notifyFormFailed(player, "Violations List");
    openNextTick(() => openViolationsMenu(player));
  }
}

function openViolationDetail(player, entry, filter = "all", pageIndex = 0) {
  try {
    dbgInfo("ui", `Opened Violation Detail for ${entry?.name ?? "Unknown"}.`);
    const key = entry?.key ?? "";
    const name = entry?.name ?? "Unknown";
    const violations = entry?.violations ?? 0;
    const lastViolationAt = entry?.lastViolationAt ?? 0;
    const reason = entry?.reason ?? "";
    const kickLoop = entry?.kickLoop ?? {};
    const lastSeenMs = entry?.lastSeenMs ?? 0;
    const lastKnown = entry?.lastKnown ?? null;
    const lastKnownCaptured = Number.isFinite(lastKnown?.capturedMs) ? lastKnown.capturedMs : 0;

    const body = [
      `ID: ${key || "Unknown"}`,
      `Name: ${name}`,
      `Violations: ${violations}`,
      `Last Violation: ${lastViolationAt ? formatAgo(lastViolationAt) : "Unknown"}`,
      `Last Seen: ${lastSeenMs ? formatAgo(lastSeenMs) : "Unknown"}`,
      reason ? `Reason: ${reason}` : "",
      "",
      `Kick Loop: ${kickLoop.enabled ? "ON" : "OFF"}`,
      kickLoop.since ? `Since: ${formatAgo(kickLoop.since)}` : "",
      kickLoop.lastKickAt ? `Last Kick: ${formatAgo(kickLoop.lastKickAt)}` : "",
      Number.isFinite(kickLoop.intervalSec) ? `Interval: ${kickLoop.intervalSec}s` : "",
      "",
      "Last Known Location:",
      lastKnown ? `- Coordinates: ${lastKnown.x ?? "?"}, ${lastKnown.y ?? "?"}, ${lastKnown.z ?? "?"}` : "- Coordinates: Unknown",
      lastKnown ? `- Dimension: ${prettyDimension(lastKnown.dim ?? "unknown")}` : "- Dimension: Unknown",
      lastKnownCaptured ? `- Captured: ${formatAgo(lastKnownCaptured)}` : "- Captured: Unknown",
    ].filter(Boolean).join("\n");

    const toggleLabel = kickLoop.enabled ? "Toggle Kick Loop (Off)" : "Toggle Kick Loop (On)";

    const form = new ActionFormData()
      .title(`Violations: ${name}`)
      .body(body)
      .button(toggleLabel)
      .button("Reset Violations")
      .button("Remove From Violations List")
      .button("Back");

    ForceOpen(player, form).then((res) => {
      if (!res) {
        notifyFormFailed(player, "Violation Detail");
        return openNextTick(() => openViolationList(player, filter, pageIndex));
      }
      if (res.canceled) return openNextTick(() => openViolationList(player, filter, pageIndex));
      if (res.selection === 0) return openNextTick(() => toggleViolationKickLoop(player, entry, filter, pageIndex));
      if (res.selection === 1) return openNextTick(() => confirmViolationReset(player, entry, filter, pageIndex));
      if (res.selection === 2) return openNextTick(() => confirmRemoveViolationEntry(player, entry, filter, pageIndex));
      openNextTick(() => openViolationList(player, filter, pageIndex));
    }).catch((e) => {
      dbgError("ui", `Violation detail submit failed: ${e}`);
      logConsoleWarn(`[Anti-Dupe] Violation detail submit failed: ${e}`);
      notifyFormFailed(player, "Violation Detail");
      openNextTick(() => openViolationList(player, filter, pageIndex));
    });
  } catch (e) {
    dbgError("ui", `Violation detail build failed: ${e}`);
    logConsoleWarn(`[Anti-Dupe] Violation detail build failed: ${e}`);
    notifyFormFailed(player, "Violation Detail");
    openNextTick(() => openViolationList(player, filter, pageIndex));
  }
}

function resetAllViolationScoreboards() {
  try {
    if (!ensureViolationObjectives()) return;
    const sb = world.scoreboard;
    if (!sb) return;
    const objectives = [
      VIO_OBJ_TOTAL,
      VIO_OBJ_GHOST,
      VIO_OBJ_PLANT,
      VIO_OBJ_HOPPER,
      VIO_OBJ_DROPPER,
      VIO_OBJ_ILLEGAL,
      VIO_OBJ_OTHER,
      VIO_OBJ_GLOBAL,
    ];

    for (const objId of objectives) {
      const obj = sb.getObjective(objId);
      if (!obj) continue;
      const scores = obj.getScores?.() ?? [];
      for (const s of scores) {
        const participant = s?.participant;
        if (!participant) continue;
        try {
          if (typeof obj.removeParticipant === "function") {
            obj.removeParticipant(participant);
          } else if (typeof obj.setScore === "function") {
            obj.setScore(participant, 0);
          }
        } catch {}
      }
      try {
        if (typeof obj.setScore === "function") obj.setScore(GLOBAL_PARTICIPANT, 0);
      } catch {}
    }
  } catch (e) {
    dbgWarn("violations", `Reset violation scoreboards failed: ${e}`);
  }
}

function confirmClearAllViolations(player, filter, pageIndex) {
  const form = new MessageFormData()
    .title("Clear All Violations")
    .body("This will remove ALL violation profiles from the registry. This cannot be undone.")
    .button1("Cancel")
    .button2("Clear");

  ForceOpen(player, form).then((res) => {
    if (!res) {
      notifyFormFailed(player, "Clear All Violations");
      return openNextTick(() => openViolationList(player, filter, pageIndex));
    }
    if (res.canceled || res.selection === 0) return openNextTick(() => openViolationList(player, filter, pageIndex));
    if (!violationsDbLoaded) loadViolationsDb();
    violationsDb = emptyViolationsDb();
    queueSaveViolationsDb();
    resetAllViolationScoreboards();
    try { player.sendMessage("§aAll violation profiles cleared."); } catch {}
    openNextTick(() => openViolationList(player, filter, 0));
  }).catch((e) => {
    dbgError("ui", `Clear all violations confirm failed: ${e}`);
    logConsoleWarn(`[Anti-Dupe] Clear all violations confirm failed: ${e}`);
    notifyFormFailed(player, "Clear All Violations");
    openNextTick(() => openViolationList(player, filter, pageIndex));
  });
}

function toggleViolationKickLoop(player, entry, filter, pageIndex) {
  const key = entry?.key ?? "";
  if (!key) return openNextTick(() => openViolationList(player, filter, pageIndex));
  const enabled = !entry?.kickLoop?.enabled;
  setKickLoopForKey(key, enabled);
  try { player.sendMessage(`§aKick loop ${enabled ? "enabled" : "disabled"} for ${entry?.name ?? "player"}.`); } catch {}
  openNextTick(() => openViolationList(player, filter, pageIndex));
}

function confirmViolationReset(player, entry, filter, pageIndex) {
  const nameKey = entry?.name ?? entry?.key ?? "";
  if (!nameKey) return openNextTick(() => openViolationList(player, filter, pageIndex));
  const form = new MessageFormData()
    .title("Reset Violations")
    .body(`Reset violations for ${nameKey}?\nThis clears scoreboard counts for this name.`)
    .button1("Cancel")
    .button2("Reset");

  ForceOpen(player, form).then((res) => {
    if (!res) {
      notifyFormFailed(player, "Reset Violations");
      return openNextTick(() => openViolationList(player, filter, pageIndex));
    }
    if (res.canceled || res.selection === 0) return openNextTick(() => openViolationList(player, filter, pageIndex));
    resetViolationScoresByName(nameKey, "all", true);
    if (!violationsDbLoaded) loadViolationsDb();
    const key = entry?.key ?? "";
    const existing = violationsDb.profiles?.[key];
    if (existing) {
      const kickLoopEnabled = !!existing?.kickLoop?.enabled;
      if (kickLoopEnabled) {
        violationsDb.profiles[key] = { ...existing, violations: 0, lastViolationAt: 0, reason: "" };
      } else {
        delete violationsDb.profiles[key];
      }
      queueSaveViolationsDb();
    }
    try { player.sendMessage(`§aViolations reset for ${nameKey}.`); } catch {}
    openNextTick(() => openViolationList(player, filter, pageIndex));
  }).catch((e) => {
    dbgError("ui", `Reset violator confirm failed: ${e}`);
    logConsoleWarn(`[Anti-Dupe] Reset violator confirm failed: ${e}`);
    notifyFormFailed(player, "Reset Violations");
    openNextTick(() => openViolationList(player, filter, pageIndex));
  });
}

function confirmRemoveViolationEntry(player, entry, filter, pageIndex) {
  const key = entry?.key ?? "";
  if (!key) return openNextTick(() => openViolationList(player, filter, pageIndex));
  const kickLoopEnabled = !!entry?.kickLoop?.enabled;
  if (kickLoopEnabled) {
    try { player.sendMessage("§eDisable kick loop before removing this entry."); } catch {}
    return openNextTick(() => openViolationList(player, filter, pageIndex));
  }

  const form = new MessageFormData()
    .title("Remove Violation Entry")
    .body(`Remove ${entry?.name ?? "player"} from the violations list?`)
    .button1("Cancel")
    .button2("Remove");

  ForceOpen(player, form).then((res) => {
    if (!res) {
      notifyFormFailed(player, "Remove Violation Entry");
      return openNextTick(() => openViolationList(player, filter, pageIndex));
    }
  if (res.canceled || res.selection === 0) return openNextTick(() => openViolationList(player, filter, pageIndex));
  if (!violationsDbLoaded) loadViolationsDb();
  delete violationsDb.profiles[key];
  queueSaveViolationsDb();
  try { player.sendMessage(`§aRemoved ${entry?.name ?? "player"} from the violations list.`); } catch {}
  openNextTick(() => openViolationList(player, filter, pageIndex));
  }).catch((e) => {
    dbgError("ui", `Remove violation entry failed: ${e}`);
    logConsoleWarn(`[Anti-Dupe] Remove violation entry failed: ${e}`);
    notifyFormFailed(player, "Remove Violation Entry");
    openNextTick(() => openViolationList(player, filter, pageIndex));
  });
}

function openPunishmentGlobalOptionsForm(player) {
  try {
    if (!configLoaded) loadGlobalConfig();
    dbgInfo("ui", "Opened Punishment Configuration Form.");

    const punish = globalConfig.punishments;
    const form = new ModalFormData().title("Punishment Configuration");
    try {
      dbgInfo("ui", "adding field: Enable Punishments toggle");
      addToggleCompat(form, "Enable Punishments", !!punish.enabled);
    } catch (e) {
      dbgWarn("ui", `Punishment Configuration field failed: Enable Punishments toggle: ${e}`);
      throw e;
    }
    try {
      dbgInfo("ui", "adding field: Allow Kick Actions toggle");
      addToggleCompat(form, "Allow Kick Actions", !!punish.allowKick);
    } catch (e) {
      dbgWarn("ui", `Punishment Configuration field failed: Allow Kick Actions toggle: ${e}`);
      throw e;
    }
    try {
      dbgInfo("ui", "adding field: Bypass Tag text field");
      addTextFieldCompat(form, "Bypass Tag (Optional)", "antidupe:bypass", punish.bypassTag ?? "");
    } catch (e) {
      dbgWarn("ui", `Punishment Configuration field failed: Bypass Tag text field: ${e}`);
      throw e;
    }
    try {
      dbgInfo("ui", "adding field: Clear Bypass Tag toggle");
      addToggleCompat(form, "Clear Bypass Tag", false);
    } catch (e) {
      dbgWarn("ui", `Punishment Configuration field failed: Clear Bypass Tag toggle: ${e}`);
      throw e;
    }
    try {
      dbgInfo("ui", "adding field: Global Punishment Tag text field");
      addTextFieldCompat(form, "Global Punishment Tag (Optional)", "antidupe:punishment", punish.punishmentTag ?? "");
    } catch (e) {
      dbgWarn("ui", `Punishment Configuration field failed: Global Punishment Tag text field: ${e}`);
      throw e;
    }
    try {
      dbgInfo("ui", "adding field: Clear Punishment Tag toggle");
      addToggleCompat(form, "Clear Punishment Tag", false);
    } catch (e) {
      dbgWarn("ui", `Punishment Configuration field failed: Clear Punishment Tag toggle: ${e}`);
      throw e;
    }
    try {
      dbgInfo("ui", "adding field: Kick Cooldown slider");
      addSliderCompat(
        form,
        "Kick Cooldown (Ticks)",
        0,
        200,
        5,
        clampRangeInt(punish.cooldownTicks, 0, 200, 20)
      );
    } catch (e) {
      dbgWarn("ui", `Punishment Configuration field failed: Kick Cooldown slider: ${e}`);
      throw e;
    }
    try {
      dbgInfo("ui", "adding field: Kick Reason Template text field");
      addTextFieldCompat(
        form,
        "Kick Reason Template",
        "Use {TYPE}, {COUNT}, {THRESHOLD}",
        punish.reasonTemplate ?? DEFAULT_GLOBAL_CONFIG.punishments.reasonTemplate
      );
    } catch (e) {
      dbgWarn("ui", `Punishment Configuration field failed: Kick Reason Template text field: ${e}`);
      throw e;
    }
    try {
      dbgInfo("ui", "adding field: Public Kick Message toggle");
      addToggleCompat(form, "Public Kick Message", !!punish.publicKickMessage);
    } catch (e) {
      dbgWarn("ui", `Punishment Configuration field failed: Public Kick Message toggle: ${e}`);
      throw e;
    }

    ForceOpen(player, form).then((response) => {
      if (!response) {
        notifyFormFailed(player, "Punishment Configuration");
        return openNextTick(() => openPunishmentGlobalOptionsHub(player));
      }
      if (response.canceled) return openNextTick(() => openPunishmentGlobalOptionsHub(player));
      const v = response.formValues ?? [];
      const bypassInput = String(v[2] ?? "").trim().slice(0, 32);
      const clearBypass = !!v[3];
      const punishmentInput = String(v[4] ?? "").trim().slice(0, 32);
      const clearPunishment = !!v[5];
      const reasonInput = String(v[7] ?? "").trim().slice(0, 120);
      const bypassTag = clearBypass
        ? ""
        : (bypassInput ? bypassInput : globalConfig.punishments.bypassTag);
      const punishmentTag = clearPunishment
        ? ""
        : (punishmentInput ? punishmentInput : globalConfig.punishments.punishmentTag);
      const reasonTemplate = reasonInput
        ? reasonInput
        : globalConfig.punishments.reasonTemplate;

      globalConfig = normalizeConfig({
        ...globalConfig,
        punishments: {
          ...globalConfig.punishments,
          enabled: !!v[0],
          allowKick: !!v[1],
          bypassTag,
          punishmentTag,
          cooldownTicks: clampRangeInt(v[6], 0, 200, globalConfig.punishments.cooldownTicks),
          reasonTemplate,
          publicKickMessage: !!v[8],
          types: globalConfig.punishments.types,
        },
      });

      queueSaveGlobalConfig();
      try { player.sendMessage("§aPunishment Configuration Updated."); } catch {}
      openNextTick(() => openPunishmentGlobalOptionsHub(player));
    }).catch((e) => {
      dbgError("ui", `Punishment configuration submit failed: ${e}`);
      logConsoleWarn(`[Anti-Dupe] Punishment configuration submit failed: ${e}`);
      notifyFormFailed(player, "Punishment Configuration");
      openNextTick(() => openPunishmentGlobalOptionsHub(player));
    });
  } catch (e) {
    dbgError("ui", `Punishments form build failed: ${e}`);
    logConsoleWarn(`[Anti-Dupe] Punishments form build failed: ${e}`);
    try { player.sendMessage("§c[Anti-Dupe] Punishment Configuration UI failed to build. Check console warnings."); } catch {}
    notifyFormFailed(player, "Punishment Configuration");
    openNextTick(() => openPunishmentGlobalOptionsHub(player));
  }
}

function formatDupeTypeRulesBlock(key) {
  const punish = globalConfig.punishments ?? {};
  const types = globalConfig.punishments?.types ?? {};
  const t = types[key] ?? {};
  const enabled = t.enabled ? "Enabled" : "Disabled";
  const threshold = Number.isFinite(t.threshold) && t.threshold > 0 ? String(t.threshold) : "Disabled";
  const tag = t.tag ? t.tag : "None";
  const thresholdValue = Number.isFinite(t.threshold) ? t.threshold : 0;
  const kickThreshold = t.kickAtThreshold && punish.allowKick && thresholdValue > 0
    ? String(thresholdValue)
    : "Off";
  const kickIfTagged = t.kickIfTaggedOnRepeat ? "On" : "Off";
  let kickAction = "Off";
  if (!punish.allowKick) kickAction = "Off (Global Kick Disabled)";
  else if (!t.kickAtThreshold) kickAction = "Off (Kick At Threshold Off)";
  else if (!Number.isFinite(thresholdValue) || thresholdValue <= 0) kickAction = "Off (Threshold Disabled)";
  else kickAction = "On (At Threshold)";

  return [
    `${prettyTypeKey(key)}: ${enabled}`,
    `Threshold: ${threshold} | Kick Threshold: ${kickThreshold}`,
    `Tag: ${tag} | Kick If Tagged: ${kickIfTagged} | Kick Action: ${kickAction}`,
  ].join("\n");
}

function openPunishmentTypeMenu(player) {
  try {
    if (!configLoaded) loadGlobalConfig();
    dbgInfo("ui", "Opened Punishment Type Menu.");

    const body = [
      formatDupeTypeRulesBlock("ghost"),
      "",
      formatDupeTypeRulesBlock("plant"),
      "",
      formatDupeTypeRulesBlock("hopper"),
      "",
      formatDupeTypeRulesBlock("dropper"),
      "",
      formatDupeTypeRulesBlock("illegal"),
      "",
      formatDupeTypeRulesBlock("other"),
    ].join("\n");

    const form = new ActionFormData()
      .title("Dupe Type Rules")
      .body(body)
      .button("Ghost Stack")
      .button("Piston")
      .button("Hopper")
      .button("Dropper")
      .button("Illegal Stack")
      .button("Other")
      .button("Back");

    ForceOpen(player, form).then((res) => {
      if (!res) {
        notifyFormFailed(player, "Punishment Type Menu");
        return openNextTick(() => openPunishmentsMenu(player));
      }
      if (res.canceled) return openNextTick(() => openPunishmentsMenu(player));
      if (res.selection === 0) openNextTick(() => openPunishmentTypeForm(player, "ghost"));
      else if (res.selection === 1) openNextTick(() => openPunishmentTypeForm(player, "plant"));
      else if (res.selection === 2) openNextTick(() => openPunishmentTypeForm(player, "hopper"));
      else if (res.selection === 3) openNextTick(() => openPunishmentTypeForm(player, "dropper"));
      else if (res.selection === 4) openNextTick(() => openPunishmentTypeForm(player, "illegal"));
      else if (res.selection === 5) openNextTick(() => openPunishmentTypeForm(player, "other"));
      else openNextTick(() => openPunishmentsMenu(player));
    }).catch((e) => {
      dbgError("ui", `Punishment type menu submit failed: ${e}`);
      logConsoleWarn(`[Anti-Dupe] Punishment type menu submit failed: ${e}`);
      notifyFormFailed(player, "Punishment Type Menu");
      openNextTick(() => openPunishmentsMenu(player));
    });
  } catch (e) {
    dbgError("ui", `Punishment type menu build failed: ${e}`);
    logConsoleWarn(`[Anti-Dupe] Punishment type menu build failed: ${e}`);
    notifyFormFailed(player, "Punishment Type Menu");
    openNextTick(() => openPunishmentsMenu(player));
  }
}

function openPunishmentTypeForm(player, key) {
  try {
    if (!configLoaded) loadGlobalConfig();
    const typeSettings = globalConfig.punishments?.types?.[key] ?? {};
    const title = `Rule: ${prettyTypeKey(key)}`;

    const form = new ModalFormData().title(title);
    addToggleCompat(form, "Enabled", !!typeSettings.enabled);
    addTextFieldCompat(form, "Threshold (0 = Disabled)", "0-200", String(typeSettings.threshold ?? ""));
    addTextFieldCompat(form, "Violation Tag (Optional)", "antidupe:violator", typeSettings.tag ?? "");
    addToggleCompat(form, "Clear Violation Tag", false);
    addToggleCompat(form, "Kick At Threshold", !!typeSettings.kickAtThreshold);
    addToggleCompat(form, "Kick If Tagged On Repeat", !!typeSettings.kickIfTaggedOnRepeat);

    ForceOpen(player, form).then((response) => {
      if (!response) {
        notifyFormFailed(player, "Punishment Rule");
        return openNextTick(() => openPunishmentTypeMenu(player));
      }
      if (response.canceled) return openNextTick(() => openPunishmentTypeMenu(player));
      const v = response.formValues ?? [];
      const thresholdInput = String(v[1] ?? "").trim();
      let threshold = typeSettings.threshold;
      if (thresholdInput.length > 0) {
        const parsedThreshold = parseInt(thresholdInput, 10);
        if (Number.isFinite(parsedThreshold)) {
          threshold = parsedThreshold;
        } else {
          try { player.sendMessage("§eThreshold value was invalid. Keeping previous value."); } catch {}
        }
      }
      const tagInput = String(v[2] ?? "").trim().slice(0, 32);
      const clearTag = !!v[3];
      const tagOverride = clearTag
        ? ""
        : (tagInput ? tagInput : typeSettings.tag);

      const updatedTypes = {
        ...globalConfig.punishments.types,
        [key]: {
          ...globalConfig.punishments.types[key],
          enabled: !!v[0],
          threshold: clampRangeInt(threshold, 0, 200, 0),
          tag: tagOverride,
          kickAtThreshold: !!v[4],
          kickIfTaggedOnRepeat: !!v[5],
        },
      };

      globalConfig = normalizeConfig({
        ...globalConfig,
        punishments: {
          ...globalConfig.punishments,
          types: updatedTypes,
        },
      });

      queueSaveGlobalConfig();
      try { player.sendMessage(`§aPunishment Rule Updated: §f${prettyTypeKey(key)}`); } catch {}
      openNextTick(() => openPunishmentTypeMenu(player));
    }).catch((e) => {
      dbgError("ui", `Punishment rule submit failed: ${e}`);
      logConsoleWarn(`[Anti-Dupe] Punishment rule submit failed: ${e}`);
      notifyFormFailed(player, "Punishment Rule");
      openNextTick(() => openPunishmentTypeMenu(player));
    });
  } catch (e) {
    dbgError("ui", `Punishments form build failed: ${e}`);
    logConsoleWarn(`[Anti-Dupe] Punishments form build failed: ${e}`);
    notifyFormFailed(player, "Punishment Rule");
    openNextTick(() => openPunishmentsMenu(player));
  }
}

function openConfigurationForm(player) {
  if (!configLoaded) loadGlobalConfig();

  dbgInfo("ui", "Opened Configuration Form.");

  const form = new ModalFormData().title("Configuration (World)");
  addToggleCompat(form, "Ghost Stack Patch", !!globalConfig.ghostPatch);
  addToggleCompat(form, "Piston Dupe Patch", !!globalConfig.plantPatch);
  addToggleCompat(form, "Hopper Dupe Patch", !!globalConfig.hopperPatch);
  addToggleCompat(form, "Dropper Dupe Patch", !!globalConfig.dropperPatch);
  addToggleCompat(form, "Illegal Stack Patch", !!globalConfig.illegalStackPatch);

  ForceOpen(player, form).then((response) => {
    if (!response) {
      notifyFormFailed(player, "Configuration");
      return openNextTick(() => openSettingsMenu(player));
    }
    if (response.canceled) return openNextTick(() => openSettingsMenu(player));

    const v = response.formValues ?? [];
    globalConfig = normalizeConfig({
      ...globalConfig,
      ghostPatch:        !!v[0],
      plantPatch:        !!v[1],
      hopperPatch:       !!v[2],
      dropperPatch:      !!v[3],
      illegalStackPatch: !!v[4],
      restrictedItems:   globalConfig.restrictedItems,
    });

    rebuildRestrictedItemsSet();
    queueSaveGlobalConfig();
    dbgWarn("config", "World configuration updated via UI.");

    try { player.sendMessage("§aWorld Configuration Updated."); } catch {}
    openNextTick(() => openSettingsMenu(player));
  }).catch((e) => {
    dbgError("ui", `Configuration submit failed: ${e}`);
    console.warn(`[Anti-Dupe] Configuration submit failed: ${e}`);
    notifyFormFailed(player, "Configuration");
    openNextTick(() => openSettingsMenu(player));
  });
}

function formatRestrictedItemsList(maxLines = 20) {
  const items = Array.isArray(globalConfig.restrictedItems) ? globalConfig.restrictedItems : [];
  if (!items.length) return "None";

  const shown = items.slice(0, maxLines);
  let out = shown.map((v, i) => `${i + 1}) ${v}`).join("\n");
  if (items.length > maxLines) out += `\n\n...and ${items.length - maxLines} more`;
  return out;
}

// --- Restricted Items UI ---
function openRestrictedItemsMenu(player) {
  if (!configLoaded) loadGlobalConfig();

  const count = Array.isArray(globalConfig.restrictedItems) ? globalConfig.restrictedItems.length : 0;
  const preview = formatRestrictedItemsList(12);

  dbgInfo("ui", "Opened Restricted Items Menu.");

  const form = new ActionFormData()
    .title("Restricted Items (World)")
    .body(`Count: ${count}\n\nPreview:\n${preview}`)
    .button("View Full List")
    .button("Add Item")
    .button("Remove Item")
    .button("Reset to Defaults")
    .button("Back");

  ForceOpen(player, form)
    .then((res) => {
      if (!res) {
        notifyFormFailed(player, "Restricted Items");
        return openNextTick(() => openSettingsMenu(player));
      }
      if (res.canceled) return openNextTick(() => openSettingsMenu(player));

      if (res.selection === 0) openNextTick(() => openRestrictedItemsViewer(player));
      else if (res.selection === 1) openNextTick(() => openAddRestrictedItemForm(player));
      else if (res.selection === 2) openNextTick(() => openRemoveRestrictedItemForm(player));
      else if (res.selection === 3) openNextTick(() => confirmResetRestrictedItems(player));
      else openNextTick(() => openSettingsMenu(player));
    })
    .catch((e) => {
      dbgError("ui", `Restricted Items menu failed: ${e}`);
      console.warn(`[Anti-Dupe] Restricted Items menu failed: ${e}`);
      notifyFormFailed(player, "Restricted Items");
      openNextTick(() => openSettingsMenu(player));
    });
}

function openRestrictedItemsViewer(player) {
  if (!configLoaded) loadGlobalConfig();

  dbgInfo("ui", "Opened Restricted Items Viewer.");

  const body = formatRestrictedItemsList(80);

  const form = new MessageFormData()
    .title("Restricted Items")
    .body(body)
    .button1("Close")
    .button2("Back");

  ForceOpen(player, form)
    .then((res) => {
      if (!res) {
        notifyFormFailed(player, "Restricted Items Viewer");
        return openNextTick(() => openRestrictedItemsMenu(player));
      }
      if (res.canceled) return openNextTick(() => openRestrictedItemsMenu(player));
      if (res.selection === 1) openNextTick(() => openRestrictedItemsMenu(player));
    })
    .catch((e) => {
      dbgError("ui", `Restricted Items viewer failed: ${e}`);
      console.warn(`[Anti-Dupe] Restricted Items viewer failed: ${e}`);
      notifyFormFailed(player, "Restricted Items Viewer");
      openNextTick(() => openRestrictedItemsMenu(player));
    });
}
// ModalFormData.textField compatibility wrapper.
function addTextFieldCompat(form, label, placeholder = "", defaultValue = "") {
  const defaultStr = String(defaultValue ?? "");
  // Legacy overload: defaultValue string.
  try {
    form.textField(label, placeholder, defaultStr);
    return form;
  } catch (e1) {
    // Newer overload: options object.
    try {
      form.textField(label, placeholder, { defaultValue: defaultStr });
      return form;
    } catch (e2) {
      // Fallback: no default support.
      try {
        form.textField(label, placeholder);
        return form;
      } catch (e3) {
        dbgError("ui", `Unable to attach text field: ${e1} | ${e2} | ${e3}`);
        return form;
      }
    }
  }
}

// ModalFormData.toggle compatibility wrapper.
function addToggleCompat(form, label, defaultValue = false, tooltip = "") {
  const defaultBool = !!defaultValue;
  // Legacy overload: defaultValue boolean.
  try {
    form.toggle(label, defaultBool);
    return form;
  } catch (e1) {
    try {
      const opts = { defaultValue: defaultBool };
      const tip = String(tooltip ?? "").trim();
      if (tip) opts.tooltip = tip;
      form.toggle(label, opts);
      return form;
    } catch (e2) {
      try {
        form.toggle(label);
        return form;
      } catch (e3) {
        dbgError("ui", `toggle attach failed: ${e1} | ${e2} | ${e3}`);
        return form;
      }
    }
  }
}

// ModalFormData.slider compatibility wrapper.
let sliderCompatLogged = false;
function addSliderCompat(form, label, min, max, step, defaultValue) {
  try {
    form.slider(label, min, max, step, defaultValue);
    if (!sliderCompatLogged) {
      const msg = "Slider overload active: slider(label, min, max, step, defaultValue)";
      dbgInfo("ui", msg);
      sliderCompatLogged = true;
    }
    return form;
  } catch (e1) {
    if (String(e1).includes("Incorrect number of arguments")) {
      try {
        form.slider(label, min, max, defaultValue);
        if (!sliderCompatLogged) {
          const msg = "Slider overload active: slider(label, min, max, defaultValue)";
          dbgInfo("ui", msg);
          sliderCompatLogged = true;
        }
        return form;
      } catch (e2) {
        try {
          form.slider(label, min, max);
          if (!sliderCompatLogged) {
            const msg = "Slider overload active: slider(label, min, max)";
            dbgInfo("ui", msg);
            sliderCompatLogged = true;
          }
          return form;
        } catch (e3) {
          dbgError("ui", `slider attach failed: ${e1} | ${e2} | ${e3}`);
          return form;
        }
      }
    }
    dbgError("ui", `slider attach failed: ${e1}`);
    return form;
  }
}



function openAddRestrictedItemForm(player) {
  dbgInfo("ui", "Opened Add Restricted Item Form.");

  const form = new ModalFormData().title("Add Restricted Item");
  addTextFieldCompat(form, "Enter Item ID (namespace:item)", "minecraft:bundle", "");

  ForceOpen(player, form).then((res) => {
    if (!res) {
      notifyFormFailed(player, "Add Restricted Item");
      return openNextTick(() => openRestrictedItemsMenu(player));
    }
    if (res.canceled) return openNextTick(() => openRestrictedItemsMenu(player));

    const raw = String((res.formValues ?? [])[0] ?? "").trim().toLowerCase();
    if (!raw) {
      dbgWarn("restrict", "Add restricted item: empty input.");
      try { player.sendMessage("§cInvalid input: empty Item ID."); } catch {}
      return openNextTick(() => openRestrictedItemsMenu(player));
    }

    if (!isValidNamespacedId(raw)) {
      dbgWarn("restrict", `Add restricted item: invalid ID format: ${raw}`);
      try { player.sendMessage("§cInvalid Item ID. Use namespace:item (e.g., minecraft:bundle)."); } catch {}
      return openNextTick(() => openRestrictedItemsMenu(player));
    }

    const list = Array.isArray(globalConfig.restrictedItems) ? globalConfig.restrictedItems.slice() : [];
    if (list.includes(raw)) {
      dbgInfo("restrict", `Add restricted item: already exists: ${raw}`);
      try { player.sendMessage("§eThat item is already restricted."); } catch {}
      return openNextTick(() => openRestrictedItemsMenu(player));
    }

    if (list.length >= MAX_RESTRICTED_ITEMS) {
      dbgWarn("restrict", `Add restricted item denied (max reached): ${MAX_RESTRICTED_ITEMS}`);
      try { player.sendMessage(`§cRestricted list full (max ${MAX_RESTRICTED_ITEMS}). Remove an item first.`); } catch {}
      return openNextTick(() => openRestrictedItemsMenu(player));
    }

    list.push(raw);

    globalConfig = normalizeConfig({
      ...globalConfig,
      restrictedItems: list,
    });

    rebuildRestrictedItemsSet();
    queueSaveGlobalConfig();

    dbgWarn("restrict", `Restricted item added: ${raw}`);
    try { player.sendMessage(`§aRestricted Item Added: §f${raw}`); } catch {}

    openNextTick(() => openRestrictedItemsMenu(player));
  }).catch((e) => {
    dbgError("ui", `Add restricted item submit failed: ${e}`);
    console.warn(`[Anti-Dupe] Add restricted item submit failed: ${e}`);
    notifyFormFailed(player, "Add Restricted Item");
    openNextTick(() => openRestrictedItemsMenu(player));
  });
}


function openRemoveRestrictedItemForm(player) {
  dbgInfo("ui", "Opened Remove Restricted Item Form.");

  const preview = formatRestrictedItemsList(10);
  const form = new ModalFormData().title("Remove Restricted Item");

  addTextFieldCompat(
    form,
    `Enter Item ID to Remove\n\nPreview:\n${preview}`,
    "minecraft:bundle",
    ""
  );

  ForceOpen(player, form).then((res) => {
    if (!res) {
      notifyFormFailed(player, "Remove Restricted Item");
      return openNextTick(() => openRestrictedItemsMenu(player));
    }
    if (res.canceled) return openNextTick(() => openRestrictedItemsMenu(player));

    const raw = String((res.formValues ?? [])[0] ?? "").trim().toLowerCase();
    if (!raw) {
      dbgWarn("restrict", "Remove restricted item: empty input.");
      try { player.sendMessage("§cInvalid input: empty Item ID."); } catch {}
      return openNextTick(() => openRestrictedItemsMenu(player));
    }

    const list = Array.isArray(globalConfig.restrictedItems) ? globalConfig.restrictedItems.slice() : [];
    const idx = list.indexOf(raw);

    if (idx === -1) {
      dbgInfo("restrict", `Remove restricted item: not found: ${raw}`);
      try { player.sendMessage("§eThat item is not currently restricted."); } catch {}
      return openNextTick(() => openRestrictedItemsMenu(player));
    }

    list.splice(idx, 1);

    globalConfig = normalizeConfig({
      ...globalConfig,
      restrictedItems: list,
    });

    rebuildRestrictedItemsSet();
    queueSaveGlobalConfig();

    dbgWarn("restrict", `Restricted item removed: ${raw}`);
    try { player.sendMessage(`§aRestricted Item Removed: §f${raw}`); } catch {}

    openNextTick(() => openRestrictedItemsMenu(player));
  }).catch((e) => {
    dbgError("ui", `Remove restricted item submit failed: ${e}`);
    console.warn(`[Anti-Dupe] Remove restricted item submit failed: ${e}`);
    notifyFormFailed(player, "Remove Restricted Item");
    openNextTick(() => openRestrictedItemsMenu(player));
  });
}


function confirmResetRestrictedItems(player) {
  dbgWarn("ui", "Opened Restricted Items Reset Confirmation.");

  const form = new MessageFormData()
    .title("Reset Restricted Items")
    .body("This will reset the restricted item list to defaults (bundles).\n\nProceed?")
    .button1("Cancel")
    .button2("Reset");

  ForceOpen(player, form).then((res) => {
    if (!res) {
      notifyFormFailed(player, "Reset Restricted Items");
      return openNextTick(() => openRestrictedItemsMenu(player));
    }
    if (res.canceled) return openNextTick(() => openRestrictedItemsMenu(player));

    if (res.selection === 1) {
      globalConfig = normalizeConfig({
        ...globalConfig,
        restrictedItems: DEFAULT_RESTRICTED_ITEMS.slice(),
      });

      rebuildRestrictedItemsSet();
      queueSaveGlobalConfig();

      dbgWarn("restrict", "Restricted item list reset to defaults.");
      try { player.sendMessage("§aRestricted Items Reset to Defaults."); } catch {}

    }
    openNextTick(() => openRestrictedItemsMenu(player));
  }).catch((e) => {
    dbgError("ui", `Reset restricted items submit failed: ${e}`);
    console.warn(`[Anti-Dupe] Reset restricted items submit failed: ${e}`);
    notifyFormFailed(player, "Reset Restricted Items");
    openNextTick(() => openRestrictedItemsMenu(player));
  });
}

function openPersonalSettingsForm(player) {
  dbgInfo("ui", "Opened Personal Settings Form.");

  const form = new ModalFormData().title("Personal Settings (Admin)");
  addToggleCompat(form, "Public Messages", !player.hasTag?.(DISABLE_PUBLIC_MSG_TAG));
  addToggleCompat(form, "Admin Messages", !player.hasTag?.(DISABLE_ADMIN_MSG_TAG));
  addToggleCompat(form, "Admin Alerts (Coordinates)", !player.hasTag?.(DISABLE_ALERT_TAG));

  ForceOpen(player, form).then((response) => {
    if (!response) {
      notifyFormFailed(player, "Personal Settings");
      return openNextTick(() => openSettingsMenu(player));
    }
    if (response.canceled) return openNextTick(() => openSettingsMenu(player));

    const tags = [DISABLE_PUBLIC_MSG_TAG, DISABLE_ADMIN_MSG_TAG, DISABLE_ALERT_TAG];

    (response.formValues ?? []).forEach((enabled, i) => {
      const tag = tags[i];
      if (!tag) return;

      if (enabled) {
        if (player.hasTag?.(tag)) player.removeTag(tag);
      } else {
        if (!player.hasTag?.(tag)) player.addTag(tag);
      }
    });

    dbgInfo("ui", "Personal settings updated (tags toggled).");
    try { player.sendMessage("§aPersonal Settings Updated."); } catch {}
    openNextTick(() => openSettingsMenu(player));
  }).catch((e) => {
    dbgError("ui", `Personal settings submit failed: ${e}`);
    console.warn(`[Anti-Dupe] Personal settings submit failed: ${e}`);
    notifyFormFailed(player, "Personal Settings");
    openNextTick(() => openSettingsMenu(player));
  });
}

// --- Debug UI (Runtime Only) ---
function formatDebugEntry(e) {
  const lvl = (e?.lvl ?? "info").toUpperCase();
  const area = e?.area ?? "core";
  const msg = e?.msg ?? "";
  const t = e?.t ?? "";
  const tick = Number.isFinite(e?.tick) ? e.tick : "?";
  return `[${lvl}] [${area}] tick=${tick} | ${t}\n${msg}`;
}

function formatDebugLogText(maxEntries = 50) {
  const total = debugLog.length;
  if (!total) return "No debug entries available (runtime).";

  const newestFirst = [...debugLog].reverse().slice(0, maxEntries);
  const blocks = newestFirst.map(formatDebugEntry);

  let out = `Debug Log (${Math.min(total, maxEntries)}/${total} Shown)\n\n`;
  out += blocks.join("\n\n---\n\n");

  if (total > maxEntries) out += `\n\n---\n\nNote: ${total - maxEntries} older entries not shown.`;
  return out;
}

function getRuntimeStatusText() {
  if (!configLoaded) loadGlobalConfig();

  const scanAny = !!(globalConfig.plantPatch || globalConfig.hopperPatch || globalConfig.dropperPatch);
  const restrictedCount = Array.isArray(globalConfig.restrictedItems) ? globalConfig.restrictedItems.length : 0;

  const lines = [];
  lines.push("Runtime Status");
  lines.push("");
  lines.push(`Tick: ${system.currentTick}`);
  lines.push(`Persistence Enabled: ${persistenceEnabled}`);
  lines.push(`Configuration Loaded: ${configLoaded}`);
  lines.push(`Incident Logs Loaded: ${logsLoaded}`);
  lines.push(`Violation Stats Loaded: ${vioStatsLoaded}`);
  lines.push(`Violation Objectives Ready: ${vioObjectivesReady}`);
  lines.push(`Scoreboard Available: ${!!world.scoreboard}`);
  lines.push("");
  lines.push("Patches:");
  lines.push(`- Ghost Stack Patch: ${!!globalConfig.ghostPatch}`);
  lines.push(`- Piston Dupe Patch: ${!!globalConfig.plantPatch}`);
  lines.push(`- Hopper Dupe Patch: ${!!globalConfig.hopperPatch}`);
  lines.push(`- Dropper Dupe Patch: ${!!globalConfig.dropperPatch}`);
  lines.push(`- Illegal Stack Patch: ${!!globalConfig.illegalStackPatch}`);
  lines.push("");
  lines.push(`Scanner Enabled (Any): ${scanAny}`);
  lines.push(`Restricted Item Count: ${restrictedCount} (Set Size=${restrictedItemsSet?.size ?? 0})`);
  lines.push("");
  lines.push("Debug Counters (Runtime):");
  lines.push(`- Info: ${debugCounters.info}`);
  lines.push(`- Warn: ${debugCounters.warn}`);
  lines.push(`- Error: ${debugCounters.error}`);
  lines.push(`- Stored Entries: ${debugLog.length}/${DEBUG_LOG_MAX}`);

  return lines.join("\n");
}

function openDebugMenu(player) {
  dbgInfo("ui", "Opened Debug Menu.");

  const last = debugLog.length ? debugLog[debugLog.length - 1] : null;
  const lastLine = last ? `[${String(last.lvl).toUpperCase()}] ${last.area}: ${last.msg}` : "None";

  const body =
    `Entries: ${debugLog.length}/${DEBUG_LOG_MAX}\n` +
    `Errors: ${debugCounters.error} | Warnings: ${debugCounters.warn} | Info: ${debugCounters.info}\n\n` +
    `Most Recent:\n${lastLine}`;

  const form = new ActionFormData()
    .title("Debug (Runtime)")
    .body(body)
    .button("View Debug Log")
    .button("Runtime Status")
    .button("Clear Debug Log")
    .button("Back");

  ForceOpen(player, form).then((res) => {
    if (!res) {
      notifyFormFailed(player, "Debug Menu");
      return openNextTick(() => openMainMenu(player));
    }
    if (res.canceled) return openNextTick(() => openMainMenu(player));

    if (res.selection === 0) openNextTick(() => openDebugViewer(player));
    else if (res.selection === 1) openNextTick(() => openRuntimeStatusViewer(player));
    else if (res.selection === 2) openNextTick(() => confirmClearDebugLog(player));
    else openNextTick(() => openMainMenu(player));
  }).catch((e) => {
    dbgError("ui", `Debug menu submit failed: ${e}`);
    console.warn(`[Anti-Dupe] Debug menu submit failed: ${e}`);
    notifyFormFailed(player, "Debug Menu");
    openNextTick(() => openMainMenu(player));
  });
}

function openDebugViewer(player) {
  const body = formatDebugLogText(60);

  const form = new MessageFormData()
    .title("Debug Log")
    .body(body)
    .button1("Close")
    .button2("Refresh");

  ForceOpen(player, form).then((res) => {
    if (!res) {
      notifyFormFailed(player, "Debug Log");
      return openNextTick(() => openDebugMenu(player));
    }
    if (res.canceled) return openNextTick(() => openDebugMenu(player));
    if (res.selection === 1) openNextTick(() => openDebugViewer(player));
  }).catch((e) => {
    dbgError("ui", `Debug log submit failed: ${e}`);
    console.warn(`[Anti-Dupe] Debug log submit failed: ${e}`);
    notifyFormFailed(player, "Debug Log");
    openNextTick(() => openDebugMenu(player));
  });
}

function openRuntimeStatusViewer(player) {
  const body = getRuntimeStatusText();

  const form = new MessageFormData()
    .title("Runtime Status")
    .body(body)
    .button1("Close")
    .button2("Back");

  ForceOpen(player, form).then((res) => {
    if (!res) {
      notifyFormFailed(player, "Runtime Status");
      return openNextTick(() => openDebugMenu(player));
    }
    if (res.canceled) return openNextTick(() => openDebugMenu(player));
    if (res.selection === 1) openNextTick(() => openDebugMenu(player));
  }).catch((e) => {
    dbgError("ui", `Runtime status submit failed: ${e}`);
    console.warn(`[Anti-Dupe] Runtime status submit failed: ${e}`);
    notifyFormFailed(player, "Runtime Status");
    openNextTick(() => openDebugMenu(player));
  });
}

function confirmClearDebugLog(player) {
  const form = new MessageFormData()
    .title("Clear Debug Log")
    .body("This will clear runtime debug entries (not persistent).\n\nProceed?")
    .button1("Cancel")
    .button2("Clear");

  ForceOpen(player, form).then((res) => {
    if (!res) {
      notifyFormFailed(player, "Clear Debug Log");
      return openNextTick(() => openDebugMenu(player));
    }
    if (res.canceled) return openNextTick(() => openDebugMenu(player));

    if (res.selection === 1) {
      debugLog = [];
      debugCounters = { info: 0, warn: 0, error: 0 };
      debugLastByKey = Object.create(null);
      dbgWarn("debug", "Debug log cleared by admin.");
      try { player.sendMessage("§aDebug Log Cleared."); } catch {}
    }
    openNextTick(() => openDebugMenu(player));
  }).catch((e) => {
    dbgError("ui", `Clear debug log submit failed: ${e}`);
    console.warn(`[Anti-Dupe] Clear debug log submit failed: ${e}`);
    notifyFormFailed(player, "Clear Debug Log");
    openNextTick(() => openDebugMenu(player));
  });
}

// --- Help Menu ---
function openHelpMenu(player) {
  try {
    dbgInfo("ui", "Opened Help Menu.");
    const form = new ActionFormData()
      .title("Help")
      .body("Anti-Dupe help and tips.\nUse the buttons below to learn features.")
      .button("Quick Start")
      .button("Patches & Scanning")
      .button("Punishments & Kick Logic")
      .button("Violation Resets")
      .button("Restricted Items")
      .button("Debug & Runtime Status")
      .button("Back");

    ForceOpen(player, form).then((res) => {
      if (!res) {
        notifyFormFailed(player, "Help Menu");
        return openNextTick(() => openMainMenu(player));
      }
      if (res.canceled) return openNextTick(() => openMainMenu(player));
      if (res.selection === 0) openNextTick(() => openHelpQuickStart(player));
      else if (res.selection === 1) openNextTick(() => openHelpPatches(player));
      else if (res.selection === 2) openNextTick(() => openHelpPunishments(player));
      else if (res.selection === 3) openNextTick(() => openHelpViolationResets(player));
      else if (res.selection === 4) openNextTick(() => openHelpRestrictedItems(player));
      else if (res.selection === 5) openNextTick(() => openHelpDebug(player));
      else openNextTick(() => openMainMenu(player));
    }).catch((e) => {
      dbgError("ui", `Help menu submit failed: ${e}`);
      logConsoleWarn(`[Anti-Dupe] Help menu submit failed: ${e}`);
      notifyFormFailed(player, "Help Menu");
      openNextTick(() => openMainMenu(player));
    });
  } catch (e) {
    dbgError("ui", `Help menu build failed: ${e}`);
    logConsoleWarn(`[Anti-Dupe] Help menu build failed: ${e}`);
    notifyFormFailed(player, "Help Menu");
    openNextTick(() => openMainMenu(player));
  }
}

function openHelpQuickStart(player) {
  try {
    dbgInfo("ui", "Opened Help Quick Start.");
    const body = [
      "Admins need tag: Admin",
      "Open menu: hold/use minecraft:bedrock",
      "",
      "Settings: patches and restricted items.",
      "Logs: Incident Logs and Violations Dashboard.",
      "Punishments: rules, tags, and kick settings.",
      "Debug: runtime-only logs and status.",
    ].join("\n");

    const form = new MessageFormData()
      .title("Help: Quick Start")
      .body(body)
      .button1("Back")
      .button2("Help Menu");

    ForceOpen(player, form).then((res) => {
      if (!res) {
        notifyFormFailed(player, "Help Quick Start");
        return openNextTick(() => openHelpMenu(player));
      }
      if (res.canceled) return openNextTick(() => openHelpMenu(player));
      if (res.selection === 1) openNextTick(() => openHelpMenu(player));
      else openNextTick(() => openHelpMenu(player));
    }).catch((e) => {
      dbgError("ui", `Help Quick Start submit failed: ${e}`);
      logConsoleWarn(`[Anti-Dupe] Help Quick Start submit failed: ${e}`);
      notifyFormFailed(player, "Help Quick Start");
      openNextTick(() => openHelpMenu(player));
    });
  } catch (e) {
    dbgError("ui", `Help Quick Start build failed: ${e}`);
    logConsoleWarn(`[Anti-Dupe] Help Quick Start build failed: ${e}`);
    notifyFormFailed(player, "Help Quick Start");
    openNextTick(() => openHelpMenu(player));
  }
}

function openHelpPatches(player) {
  try {
    dbgInfo("ui", "Opened Help Patches & Scanning.");
    const body = [
      "Ghost Stack Patch: clears cursor ghost stacks by dropping 1 item.",
      "Piston/Hopper/Dropper scanning: radius-based checks with enforcement.",
      "- Piston: removes illegal piston placements in range.",
      "- Hopper: wipes restricted items from hoppers.",
      "- Dropper: ejects then clears restricted items.",
      "Illegal Stack Enforcement: removes stacks with invalid amounts on interval.",
    ].join("\n");

    const form = new MessageFormData()
      .title("Help: Patches & Scanning")
      .body(body)
      .button1("Back")
      .button2("Help Menu");

    ForceOpen(player, form).then((res) => {
      if (!res) {
        notifyFormFailed(player, "Help Patches");
        return openNextTick(() => openHelpMenu(player));
      }
      if (res.canceled) return openNextTick(() => openHelpMenu(player));
      if (res.selection === 1) openNextTick(() => openHelpMenu(player));
      else openNextTick(() => openHelpMenu(player));
    }).catch((e) => {
      dbgError("ui", `Help Patches submit failed: ${e}`);
      logConsoleWarn(`[Anti-Dupe] Help Patches submit failed: ${e}`);
      notifyFormFailed(player, "Help Patches");
      openNextTick(() => openHelpMenu(player));
    });
  } catch (e) {
    dbgError("ui", `Help Patches build failed: ${e}`);
    logConsoleWarn(`[Anti-Dupe] Help Patches build failed: ${e}`);
    notifyFormFailed(player, "Help Patches");
    openNextTick(() => openHelpMenu(player));
  }
}

function openHelpPunishments(player) {
  try {
    dbgInfo("ui", "Opened Help Punishments.");
    const body = [
      "Enable Punishments = master on/off.",
      "Allow Kick Actions = global kick permission.",
      "",
      "Per type: Enabled, Threshold, Kick At Threshold, Kick If Tagged On Repeat.",
      "Bypass Tag: skip punishments if player has bypassTag.",
      "Punishment tags: per-type tag overrides global punishmentTag.",
      "Effective tag = type tag or global tag.",
      "",
      "Tokens: {TYPE}, {COUNT}, {THRESHOLD}",
      "Example: Anti-Dupe: {TYPE} ({COUNT}/{THRESHOLD})",
      "Cooldown ticks limit repeated kicks.",
      "Public Kick Message broadcasts kick notice.",
      "",
      "Kick requires Allow Kick Actions ON, Kick At Threshold ON, and Threshold > 0.",
    ].join("\n");

    const form = new MessageFormData()
      .title("Help: Punishments & Kick Logic")
      .body(body)
      .button1("Back")
      .button2("Help Menu");

    ForceOpen(player, form).then((res) => {
      if (!res) {
        notifyFormFailed(player, "Help Punishments");
        return openNextTick(() => openHelpMenu(player));
      }
      if (res.canceled) return openNextTick(() => openHelpMenu(player));
      if (res.selection === 1) openNextTick(() => openHelpMenu(player));
      else openNextTick(() => openHelpMenu(player));
    }).catch((e) => {
      dbgError("ui", `Help Punishments submit failed: ${e}`);
      logConsoleWarn(`[Anti-Dupe] Help Punishments submit failed: ${e}`);
      notifyFormFailed(player, "Help Punishments");
      openNextTick(() => openHelpMenu(player));
    });
  } catch (e) {
    dbgError("ui", `Help Punishments build failed: ${e}`);
    logConsoleWarn(`[Anti-Dupe] Help Punishments build failed: ${e}`);
    notifyFormFailed(player, "Help Punishments");
    openNextTick(() => openHelpMenu(player));
  }
}

function openHelpViolationResets(player) {
  try {
    dbgInfo("ui", "Opened Help Violation Resets.");
    const body = [
      "Location: Punishments → Violation Resets.",
      "Resets use the player NAME (scoreboard key), online or offline.",
      "Reset All Types clears all per-type scores.",
      "Reset Total Score also clears ad_total.",
      "Type menu includes Total Only option.",
      "This affects scoreboard objectives (ad_*).",
    ].join("\n");

    const form = new MessageFormData()
      .title("Help: Violation Resets")
      .body(body)
      .button1("Back")
      .button2("Help Menu");

    ForceOpen(player, form).then((res) => {
      if (!res) {
        notifyFormFailed(player, "Help Violation Resets");
        return openNextTick(() => openHelpMenu(player));
      }
      if (res.canceled) return openNextTick(() => openHelpMenu(player));
      if (res.selection === 1) openNextTick(() => openHelpMenu(player));
      else openNextTick(() => openHelpMenu(player));
    }).catch((e) => {
      dbgError("ui", `Help Violation Resets submit failed: ${e}`);
      logConsoleWarn(`[Anti-Dupe] Help Violation Resets submit failed: ${e}`);
      notifyFormFailed(player, "Help Violation Resets");
      openNextTick(() => openHelpMenu(player));
    });
  } catch (e) {
    dbgError("ui", `Help Violation Resets build failed: ${e}`);
    logConsoleWarn(`[Anti-Dupe] Help Violation Resets build failed: ${e}`);
    notifyFormFailed(player, "Help Violation Resets");
    openNextTick(() => openHelpMenu(player));
  }
}

function openHelpRestrictedItems(player) {
  try {
    dbgInfo("ui", "Opened Help Restricted Items.");
    const body = [
      "World list controls hopper/dropper wipe/eject behavior.",
      "Add/remove items as namespace:item (e.g., minecraft:bundle).",
      `MAX_RESTRICTED_ITEMS = ${MAX_RESTRICTED_ITEMS}.`,
      "Reset to defaults restores bundle list.",
      "Restricted item set is rebuilt after edits.",
    ].join("\n");

    const form = new MessageFormData()
      .title("Help: Restricted Items")
      .body(body)
      .button1("Back")
      .button2("Help Menu");

    ForceOpen(player, form).then((res) => {
      if (!res) {
        notifyFormFailed(player, "Help Restricted Items");
        return openNextTick(() => openHelpMenu(player));
      }
      if (res.canceled) return openNextTick(() => openHelpMenu(player));
      if (res.selection === 1) openNextTick(() => openHelpMenu(player));
      else openNextTick(() => openHelpMenu(player));
    }).catch((e) => {
      dbgError("ui", `Help Restricted Items submit failed: ${e}`);
      logConsoleWarn(`[Anti-Dupe] Help Restricted Items submit failed: ${e}`);
      notifyFormFailed(player, "Help Restricted Items");
      openNextTick(() => openHelpMenu(player));
    });
  } catch (e) {
    dbgError("ui", `Help Restricted Items build failed: ${e}`);
    logConsoleWarn(`[Anti-Dupe] Help Restricted Items build failed: ${e}`);
    notifyFormFailed(player, "Help Restricted Items");
    openNextTick(() => openHelpMenu(player));
  }
}

function openHelpDebug(player) {
  try {
    dbgInfo("ui", "Opened Help Debug & Runtime Status.");
    const body = [
      "Debug log is runtime-only (not persistent).",
      "Runtime Status shows loaded states, patch toggles, and counters.",
      "If a form fails to open, check Debug → View Debug Log.",
    ].join("\n");

    const form = new MessageFormData()
      .title("Help: Debug & Runtime Status")
      .body(body)
      .button1("Back")
      .button2("Help Menu");

    ForceOpen(player, form).then((res) => {
      if (!res) {
        notifyFormFailed(player, "Help Debug");
        return openNextTick(() => openHelpMenu(player));
      }
      if (res.canceled) return openNextTick(() => openHelpMenu(player));
      if (res.selection === 1) openNextTick(() => openHelpMenu(player));
      else openNextTick(() => openHelpMenu(player));
    }).catch((e) => {
      dbgError("ui", `Help Debug submit failed: ${e}`);
      logConsoleWarn(`[Anti-Dupe] Help Debug submit failed: ${e}`);
      notifyFormFailed(player, "Help Debug");
      openNextTick(() => openHelpMenu(player));
    });
  } catch (e) {
    dbgError("ui", `Help Debug build failed: ${e}`);
    logConsoleWarn(`[Anti-Dupe] Help Debug build failed: ${e}`);
    notifyFormFailed(player, "Help Debug");
    openNextTick(() => openHelpMenu(player));
  }
}

// --- Main Menu ---
function openMainMenu(player) {
  dbgInfo("ui", "Opened Main Menu.");

  const menu = new ActionFormData()
    .title("Anti-Dupe")
    .button("Settings")
    .button("Logs")
    .button("Punishments")
    .button("Debug")
    .button("Help");

  ForceOpen(player, menu).then((res) => {
    if (!res) {
      notifyFormFailed(player, "Main Menu");
      return;
    }
    if (res.canceled) return;
    if (res.selection === 0) openNextTick(() => openSettingsMenu(player));
    else if (res.selection === 1) openNextTick(() => openLogsMenu(player));
    else if (res.selection === 2) openNextTick(() => openPunishmentsMenu(player));
    else if (res.selection === 3) openNextTick(() => openDebugMenu(player));
    else openNextTick(() => openHelpMenu(player));
  }).catch((e) => {
    dbgError("ui", `Main menu submit failed: ${e}`);
    console.warn(`[Anti-Dupe] Main menu submit failed: ${e}`);
    notifyFormFailed(player, "Main Menu");
  });
}

// --- Menu Activation ---
world.beforeEvents.itemUse.subscribe((event) => {
  try {
    const source = event.source;
    const itemStack = event.itemStack;

    if (!source?.hasTag?.(ADMIN_TAG)) return;
    if (!itemStack || itemStack.typeId !== SETTINGS_ITEM) return;

    event.cancel = true;

    system.run(() => {
      openMainMenu(source);
    });
  } catch (e) {
    dbgError("ui", `itemUse menu open error: ${e}`);
  }
});

world.beforeEvents.itemUseOn.subscribe((event) => {
  try {
    const source = event.source;
    const itemStack = event.itemStack;

    if (!source?.hasTag?.(ADMIN_TAG)) return;
    if (!itemStack || itemStack.typeId !== SETTINGS_ITEM) return;

    event.cancel = true;

    system.run(() => {
      openMainMenu(source);
    });
  } catch (e) {
    dbgError("ui", `itemUseOn menu open error: ${e}`);
  }
});

// Optional menu open via block hit (mining can trigger this; guarded).
world.afterEvents.entityHitBlock.subscribe((event) => {
  try {
    const p = event.damagingEntity;
    if (!p || p.typeId !== "minecraft:player") return;
    if (!p.hasTag?.(ADMIN_TAG)) return;

    const cont = getEntityInventoryContainer(p);
    if (!cont || cont.size <= 0) return;

    const slot = getSelectedSlotSafe(p, cont.size);
    const item = cont.getItem(slot);

    if (item?.typeId === SETTINGS_ITEM) openMainMenu(p);
  } catch (e) {
    dbgWarn("ui", `entityHitBlock handler error: ${e}`);
  }
});
