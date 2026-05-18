#!/usr/bin/env node
/**
 * mBit — Minecraft chunk as LLM-native text.
 *
 * 5 perception formats:
 *   Binary  — walkable (0) / solid (1) per (X,Y,Z), one grid per Y layer
 *   Columns — (UP free, DOWN solid) per (X,Z) column
 *   Rows    — free blocks in N,S,E,W,Up,Down from centre point
 *   Surface — ground block type per (X,Z)
 *   Full    — every block as a single character, one grid per Y layer
 *
 * All formats accept arbitrary volume bounds via GET /blocks.
 *
 * API:
 *   encode(blocks, format, centerX, centerY, centerZ) → string
 *
 * The blocks array is [{x, y, z, name}, ...] as returned by GET /blocks.
 */

/**
 * Block → single character mapping.
 * Upper/mixed case for walkable (air, plants, liquids), lower case for solids.
 * Unmapped blocks get '?'.
 */
const CHAR_MAP = {
  air: ' ',        cave_air: ' ',   void_air: ' ',
  water: '~',      lava: '!',       bubble_column: '°',
  short_grass: ',', tall_grass: ';', fern: 'f', large_fern: 'F',
  dead_bush: '.',  dandelion: '*',   poppy: '*',
  oak_sapling: 's', birch_sapling: 's', spruce_sapling: 's',
  oak_leaves: 'L', birch_leaves: 'L', spruce_leaves: 'L',
  vine: 'v',       glow_lichen: 'g',
  // Solids (lowercase)
  stone: '#',      cobblestone: '#', mossy_cobblestone: '#',
  dirt: 'd',       coarse_dirt: 'D', grass_block: 'G', rooted_dirt: 'G',
  farmland: '=',   dirt_path: '=',   podzol: 'd',
  sand: 'n',       red_sand: 'n',   gravel: 'g',
  clay: 'c',       terracotta: 'T',  white_terracotta: 'T',
  orange_terracotta: 'T', magenta_terracotta: 'T', light_blue_terracotta: 'T',
  yellow_terracotta: 'T', lime_terracotta: 'T', pink_terracotta: 'T',
  gray_terracotta: 'T', light_gray_terracotta: 'T', cyan_terracotta: 'T',
  purple_terracotta: 'T', blue_terracotta: 'T', brown_terracotta: 'T',
  green_terracotta: 'T', red_terracotta: 'T', black_terracotta: 'T',
  oak_log: 'l',    birch_log: 'l',   spruce_log: 'l', stripped_oak_log: 'l',
  oak_planks: 'w', birch_planks: 'w', spruce_planks: 'w',
  crafting_table: 'W', chest: 'C', furnace: 'H',
  coal_ore: 'o',   iron_ore: 'O',   gold_ore: 'O', diamond_ore: 'O',
  redstone_ore: 'O', lapis_ore: 'O', copper_ore: 'O',
  emerald_ore: 'O', nether_quartz_ore: 'O',
  bedrock: 'B',    obsidian: 'B',
  glass: '▢',      glass_pane: '▢',
  torch: 't',      wall_torch: 't', lantern: 't',
  brown_bed: 'b',  yellow_bed: 'b',
  spawner: 'S',    mob_spawner: 'S',
  oak_stairs: '▲', birch_stairs: '▲',
  short_dry_grass: ',', tall_dry_grass: ';',
  leaf_litter: '.', moss_block: 'm',
};

/** Special blocks that are walk-through (treat as air for binary) */
const WALKABLE = new Set([
  'air', 'cave_air', 'void_air',
  'short_grass', 'tall_grass', 'fern', 'large_fern',
  'dead_bush', 'dandelion', 'poppy', 'vine', 'glow_lichen',
  'short_dry_grass', 'tall_dry_grass',
  'leaf_litter', 'torch', 'wall_torch', 'lantern',
  'oak_sapling', 'birch_sapling', 'spruce_sapling',
  'brown_mushroom', 'red_mushroom',
  // Leaves are passable in Minecraft (walk-through, replaceable by blocks)
  'oak_leaves', 'birch_leaves', 'spruce_leaves',
  'jungle_leaves', 'acacia_leaves', 'dark_oak_leaves',
  'mangrove_leaves', 'cherry_leaves',
  'azalea_leaves', 'flowering_azalea_leaves',
]);

const PASSABLE_DESPITE_BLOCK_BB = new Set([
  // minecraft-data reports boundingBox='block' for leaves, but in-game they are passable
  'oak_leaves', 'birch_leaves', 'spruce_leaves',
  'jungle_leaves', 'acacia_leaves', 'dark_oak_leaves',
  'mangrove_leaves', 'cherry_leaves',
  'azalea_leaves', 'flowering_azalea_leaves',
]);

function charFor(blockOrName) {
  const name = typeof blockOrName === 'string' ? blockOrName : (blockOrName && blockOrName.name);
  if (!name) return '?';
  return CHAR_MAP[name] || name[0] || '?';
}

function isWalkable(blockOrName) {
  const name = typeof blockOrName === 'string' ? blockOrName : (blockOrName && blockOrName.name);
  if (!name) return true;
  const block = typeof blockOrName === 'object' ? blockOrName : null;

  // Prefer canonical minecraft-data properties when available
  if (block && block.boundingBox) {
    if (block.boundingBox === 'empty') return true;
    if (block.boundingBox === 'block' && block.transparent === true) {
      return PASSABLE_DESPITE_BLOCK_BB.has(name);
    }
    return false;
  }

  // Fallback for string-only or missing properties (backward compat)
  return WALKABLE.has(name) || name === 'water' || name === 'bubble_column';
}

/** Build a 3D lookup: grid[y][x][z] = block object */
function build3D(blocks) {
  const grid = {};
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  for (const b of blocks) {
    if (!grid[b.y]) grid[b.y] = {};
    if (!grid[b.y][b.x]) grid[b.y][b.x] = {};
    grid[b.y][b.x][b.z] = b;
    if (b.x < minX) minX = b.x; if (b.x > maxX) maxX = b.x;
    if (b.z < minZ) minZ = b.z; if (b.z > maxZ) maxZ = b.z;
    if (b.y < minY) minY = b.y; if (b.y > maxY) maxY = b.y;
  }
  return { grid, minX, maxX, minZ, maxZ, minY, maxY };
}

const AIR_BLOCK = { name: 'air', boundingBox: 'empty', transparent: true };

function blockAt3D(grid, x, y, z) {
  return (grid[y] && grid[y][x] && grid[y][x][z]) || AIR_BLOCK;
}

// ═══════════════════════════════════════════════════════════════
// FORMAT 1: Binary — walkable map per (X,Y,Z), Y-major (bottom→top)
// ═══════════════════════════════════════════════════════════════
function encodeBinary(blocks) {
  const { grid, minX, maxX, minZ, maxZ, minY, maxY } = build3D(blocks);
  let out = '';
  for (let y = minY; y <= maxY; y++) {
    out += `--- Y=${y} ---\n`;
    for (let z = minZ; z <= maxZ; z++) {
      for (let x = minX; x <= maxX; x++) {
        const block = blockAt3D(grid, x, y, z);
        const solid = !isWalkable(block);
        out += solid ? '1' : '0';
      }
      out += '\n';
    }
    out += '\n';
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════
// FORMAT 2: Columns — (UP free, DOWN solid) per (X,Z)
// ═══════════════════════════════════════════════════════════════
function encodeColumns(blocks) {
  const { grid, minX, maxX, minZ, maxZ, minY, maxY } = build3D(blocks);
  let out = '';
  for (let z = minZ; z <= maxZ; z++) {
    for (let x = minX; x <= maxX; x++) {
      let freeUp = 0, solidDown = 0;
      let foundSolid = false;
      for (let y = minY; y <= maxY; y++) {
        const block = blockAt3D(grid, x, y, z);
        if (!foundSolid && isWalkable(block)) {
          freeUp++;
        } else if (!isWalkable(block)) {
          foundSolid = true;
          solidDown++;
        } else {
          solidDown++;
        }
      }
      out += `${freeUp},${solidDown} `;
    }
    out += '\n';
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════
// FORMAT 3: Rows — free distance in each cardinal + vertical direction
// ═══════════════════════════════════════════════════════════════
function encodeRows(blocks, centerX, centerY, centerZ) {
  const { grid, minX, maxX, minZ, maxZ, minY, maxY } = build3D(blocks);
  const cx = centerX != null ? centerX : Math.floor((minX + maxX) / 2);
  const cy = centerY != null ? centerY : Math.floor((minY + maxY) / 2);
  const cz = centerZ != null ? centerZ : Math.floor((minZ + maxZ) / 2);

  function freeDist(dx, dy, dz) {
    let dist = 0;
    let x = cx, y = cy, z = cz;
    while (x >= minX && x <= maxX && z >= minZ && z <= maxZ && y >= minY && y <= maxY) {
      x += dx; y += dy; z += dz;
      if (x < minX || x > maxX || z < minZ || z > maxZ || y < minY || y > maxY) break;
      const block = blockAt3D(grid, x, y, z);
      if (!isWalkable(block) && block.name !== 'air') break;
      dist++;
    }
    return dist;
  }

  return `N:${freeDist(0,0,-1)} S:${freeDist(0,0,1)} E:${freeDist(1,0,0)} W:${freeDist(-1,0,0)} Up:${freeDist(0,1,0)} Down:${freeDist(0,-1,0)}`;
}

// ═══════════════════════════════════════════════════════════════
// FORMAT 4: Surface — ground block character per (X,Z)
// ═══════════════════════════════════════════════════════════════
function encodeSurface(blocks) {
  const { grid, minX, maxX, minZ, maxZ, minY, maxY } = build3D(blocks);
  let out = '';
  for (let z = minZ; z <= maxZ; z++) {
    for (let x = minX; x <= maxX; x++) {
      let surfBlock = AIR_BLOCK;
      for (let y = maxY; y >= minY; y--) {
        const block = blockAt3D(grid, x, y, z);
        if (block.name !== 'air' && block.name !== 'cave_air' && block.name !== 'void_air') {
          surfBlock = block;
          break;
        }
      }
      out += charFor(surfBlock);
    }
    out += '\n';
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════
// FORMAT 5: Full — every block as char, Y-major (bottom→top)
// ═══════════════════════════════════════════════════════════════
function encodeFull(blocks) {
  const { grid, minX, maxX, minZ, maxZ, minY, maxY } = build3D(blocks);
  let out = '';
  for (let y = minY; y <= maxY; y++) {
    out += `--- Y=${y} ---\n`;
    for (let z = minZ; z <= maxZ; z++) {
      for (let x = minX; x <= maxX; x++) {
        out += charFor(blockAt3D(grid, x, y, z));
      }
      out += '\n';
    }
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════
// Main encode function
// ═══════════════════════════════════════════════════════════════
function encode(blocks, format, centerX, centerY, centerZ) {
  switch (format) {
    case 'binary':  return encodeBinary(blocks);
    case 'columns': return encodeColumns(blocks);
    case 'rows':    return encodeRows(blocks, centerX, centerY, centerZ);
    case 'surface': return encodeSurface(blocks);
    case 'full':    return encodeFull(blocks);
    default: throw new Error(`Unknown mBit format: ${format}. Use: binary, columns, rows, surface, full`);
  }
}

export { encode, CHAR_MAP, isWalkable, charFor };
