import { world, system, ItemStack } from "@minecraft/server";
import { ModalFormData } from "@minecraft/server-ui";

/**
 * 1) GHOST‑STACK DETECTION
 */
world.afterEvents.playerSpawn.subscribe(({ player, initialSpawn }) => {
  if (!initialSpawn || !player) return;
  if (player.hasTag(DISABLE_GHOST_TAG)) return; // skip if disabled

  const cursor = player.getComponent("cursor_inventory");
  const held = cursor.item;
  const inv = player.getComponent("inventory").container;
  const empty = inv.emptySlotsCount;

  if (held && held.amount === held.maxAmount && empty === 0) {
    world.getDimension("overworld").runCommand(
      `tellraw @a {"rawtext":[{"text":"§c<Anti-Dupe> §f§l${player.nameTag} §ctried to dupe with §f${held.typeId}§c!"}]}`
    );
    player.dimension.spawnItem(new ItemStack(held.typeId, 1), player.location);
    cursor.clear();
  }
});

/**
 * 2) PLANT‑DUPE CUTTER
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
  { x: 1, z: 0 }, { x: -1, z: 0 }, { x: 0, z: 1 }, { x: 0, z: -1 },
  { x: 1, z: 1 }, { x: -1, z: 1 }, { x: 1, z: -1 }, { x: -1, z: -1 },
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
          `tellraw @a {"rawtext":[{"text":"§c<Anti-Dupe> §f§l${player.nameTag} §r§ctried to dupe with §f${plantBlock.typeId}§c! Piston removed."}]}`
        );
      }
    }
  }
}

/**
 * 3) HOPPER‑BUNDLE PURGE
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

/**
 * Administrative Settings & Tag Configuration
 */
const ADMIN_TAG = "Admin";
const SETTINGS_ITEM = "minecraft:bedrock";
const DISABLE_GHOST_TAG   = "antidupe:disable_ghost";
const DISABLE_PLANT_TAG   = "antidupe:disable_plant";
const DISABLE_HOPPER_TAG  = "antidupe:disable_hopper";
const DISABLE_DROPPER_TAG = "antidupe:disable_dropper";

/**
 * 4) DROPPER PAIR & BUNDLE PURGE
 */
// facing_direction values: 0=Down,1=Up,2=North,3=South,4=West,5=East.
const FACING_VECTORS = {
  0: { x: 0, y: -1, z: 0 },
  1: { x: 0, y: 1, z: 0 },
  2: { x: 0, y: 0, z: -1 },
  3: { x: 0, y: 0, z: 1 },
  4: { x: -1, y: 0, z: 0 },
  5: { x: 1, y: 0, z: 0 },
};
const DROPPER_SCAN_RADIUS = 5;

function getFacingValue(block) {
  if (!block) return undefined;
  const perm = block.permutation;
  if (!perm) return undefined;
  let value = perm.getState("facing_direction");
  if (typeof value === "number") return value;
  value = perm.getState("minecraft:facing_direction");
  if (typeof value === "number") return value;
  return undefined;
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
      `tellraw @a {"rawtext":[{"text":"§c<Anti-Dupe> §fRemoved §7bundle§f from facing droppers near §b${player.nameTag}§f!"}]}`
    );
  }
}

/**
 * Main loop: every 10 ticks (~½s) scans around each player.
 */
system.runInterval(() => {
  for (const player of world.getAllPlayers()) {
    const dim   = player.dimension;
    const { x: cx, y: cy, z: cz } = player.location;
    const baseX = Math.floor(cx);
    const baseY = Math.floor(cy);
    const baseZ = Math.floor(cz);

    // Plant dupe
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

    // Hopper purge
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
                  `tellraw @a {"rawtext":[{"text":"§c<Anti-Dupe> §fRemoved §7${stack.typeId}§f from a nearby hopper feeding off §b${player.nameTag}§f!"}]}`
                );
              }
            }
          }
        }
      }
    }

    // Dropper pair purge
    if (!player.hasTag(DISABLE_DROPPER_TAG)) {
      const processedPairs = new Set();
      for (let dx = -DROPPER_SCAN_RADIUS; dx <= DROPPER_SCAN_RADIUS; dx++) {
        for (let dy = -DROPPER_SCAN_RADIUS; dy <= DROPPER_SCAN_RADIUS; dy++) {
          for (let dz = -DROPPER_SCAN_RADIUS; dz <= DROPPER_SCAN_RADIUS; dz++) {
            const pos = { x: baseX + dx, y: baseY + dy, z: baseZ + dz };
            const block = dim.getBlock(pos);
            if (!block || block.typeId !== "minecraft:dropper") continue;
            const facing = getFacingValue(block);
            if (facing === undefined) continue;
            const vec = FACING_VECTORS[facing];
            if (!vec) continue;
            const neighbourPos = { x: pos.x + vec.x, y: pos.y + vec.y, z: pos.z + vec.z };
            const neighbour = dim.getBlock(neighbourPos);
            if (!neighbour || neighbour.typeId !== "minecraft:dropper") continue;
            const nFacing = getFacingValue(neighbour);
            if (nFacing === undefined) continue;
            const nVec = FACING_VECTORS[nFacing];
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
 * 5) ADMIN SETTINGS FORM
 *
 * This handler listens for item use and, if the user has the “Admin” tag and
 * right‑clicks with a bedrock block, opens a configuration form.  Because
 * `ModalFormData.show()` cannot be executed in a before-event, we defer
 * showing the form using `system.run()`.  Each toggle uses `{ defaultValue: … }`
 * to set its initial state.
 */
world.beforeEvents.itemUse.subscribe((event) => {
  const { source, itemStack } = event;
  if (!source || !source.hasTag || !source.hasTag(ADMIN_TAG)) return;
  if (!itemStack || itemStack.typeId !== SETTINGS_ITEM) return;
  event.cancel = true;

  const buildForm = () => {
    return new ModalFormData()
      .title("Anti-Dupe Configuration")
      .toggle("Ghost stack patch", { defaultValue: !source.hasTag(DISABLE_GHOST_TAG) })
      .toggle("Plant dupe patch", { defaultValue: !source.hasTag(DISABLE_PLANT_TAG) })
      .toggle("Hopper bundle patch", { defaultValue: !source.hasTag(DISABLE_HOPPER_TAG) })
      .toggle("Dropper pair patch", { defaultValue: !source.hasTag(DISABLE_DROPPER_TAG) });
  };

  system.run(() => {
    const form = buildForm();
    form.show(source).then((response) => {
      if (response.canceled) return;
      const values = response.formValues;
      const mapping = [
        { enabled: values[0], tag: DISABLE_GHOST_TAG },
        { enabled: values[1], tag: DISABLE_PLANT_TAG },
        { enabled: values[2], tag: DISABLE_HOPPER_TAG },
        { enabled: values[3], tag: DISABLE_DROPPER_TAG },
      ];
      for (const entry of mapping) {
        if (entry.enabled) {
          if (source.hasTag(entry.tag)) source.removeTag(entry.tag);
        } else {
          if (!source.hasTag(entry.tag)) source.addTag(entry.tag);
        }
      }
      try {
        source.sendMessage("§aAnti-Dupe settings updated.");
      } catch (e) {
        const dim = source.dimension;
        if (dim) {
          dim.runCommand(
            `tellraw @s {"rawtext":[{"text":"§aAnti-Dupe settings updated."}]}`
          );
        }
      }
    }).catch((err) => {
      console.warn(`Anti-Dupe settings form error: ${err}`);
    });
  });
});
