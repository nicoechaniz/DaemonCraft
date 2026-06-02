#!/usr/bin/env node
/**
 * mBit — Minecraft chunk as LLM-native text.
 *
 * Single perception format:
 *   Visual — 1 char per block, deterministic, no collisions.
 *
 * Why a single format: previous mbit had binary, columns, rows, surface, full —
 * all with symbol collisions (T = 16 colors of terracotta, O = 8 ores, etc.)
 * and a fallback name[0] that produced random collisions. The bot couldn't
 * distinguish yellow_terracotta from brown_terracotta in 'full' output.
 *
 * Visual solves that with:
 * - Mnemonic chars for super-common blocks (air, water, lava, redstone_wire, torch, lantern)
 * - Category chars for groups (door→◫, chest→◰, furnace→⊡, crafting→⊞, bed→⊏, glass→▢)
 *   so 21 door types all show as ◫, 3 chests as ◰, etc. — categories stay distinct.
 * - Sequential CJK Unified Ideographs (U+4E00+) for the rest, alphabetically assigned
 *   so yellow_terracotta, brown_terracotta, orange_terracotta, red_terracotta
 *   get 4 different chars.
 *
 * Output layout (same Y-major as the old 'full'):
 *   --- Y=N ---
 *   <row Z=minZ>
 *   <row Z=minZ+1>
 *   ...
 *   <row Z=maxZ>
 *
 *   --- Y=N+1 ---
 *   ...
 *
 *   Legend (only chars present in this scan):
 *   <char> = <block_name>
 *
 * Top row = minZ (NORTH). Left col = minX (WEST). Grid centre is bot position
 * when cx/cy/cz are passed.
 *
 * API:
 *   encode(blocks, cx, cy, cz) → string
 *
 * The blocks array is [{x, y, z, name, boundingBox, transparent}, ...] as
 * returned by GET /blocks.
 */

import { BLOCK_TO_CHAR } from './block_to_char_1.21.9.js';

/** Public: any block name → single unicode char. */
export function blockToChar(name) {
  if (!name) return '?';
  if (BLOCK_TO_CHAR[name]) return BLOCK_TO_CHAR[name];
  // Unknown block (not in pre-built table, e.g. a modded block or older MC version).
  // Fall back to hash of name mod CJK pool. Same hash, same char, deterministic.
  // If a real collision with a known block happens, it will be visible in
  // the legend and the human can investigate.
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = ((h << 5) - h + name.charCodeAt(i)) | 0;
  }
  const POOL_START = 0x4E00;
  const POOL_SIZE = 20992; // CJK Unified Ideographs base range
  return String.fromCodePoint(POOL_START + (Math.abs(h) % POOL_SIZE));
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
// FORMAT: Visual — 1 char per block, with legend
// ═══════════════════════════════════════════════════════════════
export function encodeVisual(blocks) {
  const { grid, minX, maxX, minZ, maxZ, minY, maxY } = build3D(blocks);
  const usedChars = new Set();
  let out = '';
  for (let y = minY; y <= maxY; y++) {
    out += `--- Y=${y} ---\n`;
    for (let z = minZ; z <= maxZ; z++) {
      for (let x = minX; x <= maxX; x++) {
        const block = blockAt3D(grid, x, y, z);
        const c = blockToChar(block.name);
        usedChars.add(c);
        out += c;
      }
      out += '\n';
    }
  }

  // Build legend from used chars → block name(s). For category chars
  // (door, chest, etc.) multiple names map to the same char, so the
  // legend shows the first one alphabetically and indicates "and N more".
  const charToFirstName = {};
  const charToCount = {};
  for (const b of blocks) {
    const c = blockToChar(b.name);
    if (!charToFirstName[c]) charToFirstName[c] = b.name;
    charToCount[c] = (charToCount[c] || 0) + 1;
  }
  // Determine ALL names per char (for accurate "and N more")
  const allBlocksByChar = {};
  for (const [name, c] of Object.entries(BLOCK_TO_CHAR)) {
    if (!allBlocksByChar[c]) allBlocksByChar[c] = [];
    allBlocksByChar[c].push(name);
  }

  out += '\nLegend (chars in this scan):\n';
  const sortedChars = [...usedChars].sort();
  for (const c of sortedChars) {
    const total = allBlocksByChar[c] ? allBlocksByChar[c].length : 1;
    const seen = charToCount[c] || 0;
    const firstName = charToFirstName[c] || '?';
    const more = total > 1 ? ` (+${total - 1} more)` : '';
    out += `  ${c} = ${firstName}${more}  [${seen} blocks in scan]\n`;
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════
// Main encode function
// ═══════════════════════════════════════════════════════════════
/**
 * @param {Array<{x,y,z,name}>} blocks
 * @param {string} format — only 'visual' is accepted
 * @returns {string}
 */
export function encode(blocks, format, _cx, _cy, _cz) {
  if (format && format !== 'visual') {
    throw new Error(`Unknown mBit format: ${format}. The only supported format is 'visual' (single-character-per-block, no collisions).`);
  }
  return encodeVisual(blocks);
}

// Backwards-compat shims so any old import keeps working during the
// transition. They all delegate to encode() and ignore the format arg
// (only 'visual' is valid anyway).
export const encodeFull = (blocks) => encode(blocks, 'visual');
export const encodeBinary = (blocks) => {
  // Walkability bit grid (0/1) for pathfinding ground truth. 1=walkable, 0=solid.
  // Different from 'visual' but kept as a separate function because pathfinding
  // needs the binary, not the visual. Callers should use encodeBinary() directly.
  const { grid, minX, maxX, minZ, maxZ, minY, maxY } = build3D(blocks);
  let out = '';
  const isWalkable = (b) => b.boundingBox === 'empty' || (b.boundingBox === 'block' && b.transparent === true);
  for (let y = minY; y <= maxY; y++) {
    out += `--- Y=${y} ---\n`;
    for (let z = minZ; z <= maxZ; z++) {
      for (let x = minX; x <= maxX; x++) {
        out += isWalkable(blockAt3D(grid, x, y, z)) ? '0' : '1';
      }
      out += '\n';
    }
  }
  return out;
};

export function isWalkable(block) {
  if (!block) return true;
  if (block.boundingBox === 'empty') return true;
  if (block.boundingBox === 'block' && block.transparent === true) {
    // Leaves are passable in Minecraft despite boundingBox='block'
    return ['oak_leaves', 'birch_leaves', 'spruce_leaves', 'jungle_leaves',
            'acacia_leaves', 'dark_oak_leaves', 'mangrove_leaves', 'cherry_leaves',
            'azalea_leaves', 'flowering_azalea_leaves'].includes(block.name);
  }
  return false;
}
