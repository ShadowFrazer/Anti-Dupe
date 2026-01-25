// scripts/antidupe.js
import { world, system, ItemStack } from "@minecraft/server";

/**
 * 1) GHOST‐STACK DETECTION
 */
world.afterEvents.playerSpawn.subscribe(({ player, initialSpawn }) => {
  if (!initialSpawn || !player) return;

  const cursor = player.getComponent("cursor_inventory");
  const held   = cursor.item;
  const inv     = player.getComponent("inventory").container;
  const empty   = inv.emptySlotsCount;

  if (held && held.amount === held.maxAmount && empty === 0) {
    // announce
    world
      .getDimension("overworld")
      .runCommand(
        `tellraw @a {"rawtext":[{"text":"§c<Anti-Dupe> §f§l${player.nameTag} §ctried to dupe with §f${held.typeId}§c!"}]}`
      );
    // spawn one so client doesn’t vanish it
    player.dimension.spawnItem(
      new ItemStack(held.typeId, 1),
      player.location
    );
    // clear the ghost
    cursor.clear();
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
  // …add any custom two-high block IDs here
]);

const OFFSETS = [
  { x:  1, z:  0 }, { x: -1, z:  0 },
  { x:  0, z:  1 }, { x:  0, z: -1 },
  { x:  1, z:  1 }, { x: -1, z:  1 },
  { x:  1, z: -1 }, { x: -1, z: -1 },
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
        world
          .getDimension("overworld")
          .runCommand(
            `tellraw @a {"rawtext":[{"text":"§c<Anti-Dupe> §f§l${player.nameTag} §r§ctried to dupe with §f${plantBlock.typeId}§c! Piston removed."}]}`
          );
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

/**
 * Main loop: every 10 ticks (~½s) scan around each player for:
 *  - two‐high plants → purge pistons
 *  - hoppers → purge bundles
 */
system.runInterval(() => {
  for (const player of world.getAllPlayers()) {
    const dim = player.dimension;
    const { x: cx, y: cy, z: cz } = player.location;
    const baseX = Math.floor(cx);
    const baseY = Math.floor(cy);
    const baseZ = Math.floor(cz);

    // a) scan ±10 for TWO_HIGH plants
    for (let dx = -10; dx <= 10; dx++) {
      for (let dy = -10; dy <= 10; dy++) {
        for (let dz = -10; dz <= 10; dz++) {
          const b = dim.getBlock({
            x: baseX + dx,
            y: baseY + dy,
            z: baseZ + dz,
          });
          if (b && TWO_HIGH.has(b.typeId)) {
            purgePistons(player, dim, b);
          }
        }
      }
    }

    // b) scan ±HOPPER_SCAN_RADIUS for HOPPERS + bundles
    for (let dx = -HOPPER_SCAN_RADIUS; dx <= HOPPER_SCAN_RADIUS; dx++) {
      for (let dy = -HOPPER_SCAN_RADIUS; dy <= HOPPER_SCAN_RADIUS; dy++) {
        for (let dz = -HOPPER_SCAN_RADIUS; dz <= HOPPER_SCAN_RADIUS; dz++) {
          const pos = { x: baseX + dx, y: baseY + dy, z: baseZ + dz };
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
              dim.runCommand(
                `tellraw @a {"rawtext":[{"text":"§c<Anti-Dupe> §fRemoved §7${stack.typeId}§f from a nearby hopper feeding off §b${player.nameTag}§f!"}]}`
              );
            }
          }
        }
      }
    }
  }
}, 10);
