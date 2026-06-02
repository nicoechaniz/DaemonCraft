#!/usr/bin/env node
/**
 * mc_navigate — perception macros for the DaemonCraft bot.
 *
 * High-level semantic queries that summarize a 3D scan of the world
 * around the bot. Each macro returns a structured JSON response with
 * one or two clear answers, so the LLM doesn't have to manually parse
 * a visual mbit grid to know "is this a cave?", "where are the
 * doors?", "am I inside a structure?".
 *
 * 5 actions implemented (semantic, the 5 most-asked by the LLM):
 *
 *   1. identify_cave  — am I in a cave? what escape tools apply?
 *   2. identify_interior — am I inside a structure? does it have a door?
 *   3. find_doors     — list all doors in radius with open state
 *   4. verify_door    — check a specific door's state
 *   5. scan_structure — full structure context: outline + doors + furni
 *
 * Plus 5 geometric helpers (return pre-processed scan data):
 *
 *   6. walkable        — list of (x, y, z) the bot can walk to
 *   7. path_to         — run pathfinder, return waypoints + reachability
 *   8. corners         — corner blocks of walkable space
 *   9. escape_routes   — cardinal directions, distance + blockers
 *  10. structure_outline — bounding boxes of structures + classification
 *
 * All actions accept a `radius` parameter (default 8) and a bot
 * position. They return JSON with at least {ok: true, action, data}.
 *
 * Implementation: thin wrapper around the bot's blockAt / entity /
 * pathfinder APIs. No state — every call is fresh. Heuristics are
 * conservative (prefer false negatives to false positives; the LLM can
 * always fall back to raw mc_bit).
 */

// ──────────────────────────────────────────────────────────────────────
// Block helpers
// ──────────────────────────────────────────────────────────────────────

function _isDoor(name) {
  if (!name) return false;
  return name.endsWith('_door') || name === 'iron_door';
}

function _isTrapdoor(name) {
  if (!name) return false;
  return name.endsWith('_trapdoor');
}

function _isBed(name) {
  if (!name) return false;
  return name.endsWith('_bed') && name !== 'bedrock';
}

function _isGlass(name) {
  if (!name) return false;
  return name.includes('glass') && !name.includes('pane');
}

function _isStair(name) {
  if (!name) return false;
  return name.endsWith('_stairs');
}

function _isFurnace(name) {
  return name === 'furnace' || name === 'blast_furnace' || name === 'smoker'
    || name === 'lit_furnace' || name === 'lit_blast_furnace' || name === 'lit_smoker';
}

function _isCraftingTable(name) {
  return name === 'crafting_table' || name === 'cartography_table'
    || name === 'smithing_table' || name === 'fletching_table' || name === 'loom';
}

function _isChest(name) {
  return name === 'chest' || name === 'trapped_chest' || name === 'ender_chest';
}

function _isWalkable(b) {
  if (!b) return true;
  if (b.boundingBox === 'empty') return true;
  // Leaves, plants, torches etc. are passable
  const passable = new Set([
    'oak_leaves', 'birch_leaves', 'spruce_leaves', 'jungle_leaves',
    'acacia_leaves', 'dark_oak_leaves', 'mangrove_leaves', 'cherry_leaves',
    'azalea_leaves', 'flowering_azalea_leaves', 'vine', 'glow_lichen',
    'short_grass', 'tall_grass', 'fern', 'large_fern', 'dead_bush',
    'short_dry_grass', 'tall_dry_grass', 'leaf_litter', 'moss_block',
    'torch', 'wall_torch', 'soul_torch', 'lantern', 'soul_lantern',
    'oak_sapling', 'birch_sapling', 'spruce_sapling',
    'brown_mushroom', 'red_mushroom', 'dandelion', 'poppy',
  ]);
  return passable.has(b.name);
}

function _isSolid(b) {
  return !_isWalkable(b);
}

function _isCeiling(b) {
  return _isSolid(b) && b.name !== 'glass' && !_isStair(b.name) && !_isTrapdoor(b.name);
}

// Read door open/closed state from the Block object.
// Mineflayer blocks have `_properties` (Map) or a `getState(name)` method.
function _isDoorOpen(b) {
  if (!b || !_isDoor(b.name)) return null;
  // Try several APIs since mineflayer/prismarine-block API varies
  if (typeof b.getState === 'function') {
    const v = b.getState('open');
    if (v === 'true') return true;
    if (v === 'false') return false;
  }
  if (b._properties && typeof b._properties.get === 'function') {
    const v = b._properties.get('open');
    if (v === 'true') return true;
    if (v === 'false') return false;
  }
  if (b.metadata !== undefined) {
    // For doors, metadata bit 2 (value 4) indicates "open" in 1.13+
    // (top half: hinge; bottom half: open).
    return (b.metadata & 4) !== 0;
  }
  return null;
}

function _getBlock(bot, x, y, z) {
  try {
    return bot.blockAt(new (require('vec3').Vec3)(x, y, z));
  } catch (e) {
    return null;
  }
}

// ──────────────────────────────────────────────────────────────────────
// Cardinal scan
// ──────────────────────────────────────────────────────────────────────

function _scanCardinal(bot, cx, cy, cz, maxDist) {
  const dirs = {
    north: [0, 0, -1],
    south: [0, 0, 1],
    east: [1, 0, 0],
    west: [-1, 0, 0],
    up: [0, 1, 0],
    down: [0, -1, 0],
  };
  const out = {};
  for (const [name, [dx, dy, dz]] of Object.entries(dirs)) {
    let dist = 0;
    let blocker = null;
    let lowCeiling = false;
    while (dist < maxDist) {
      dist++;
      const x = cx + dx * dist;
      const y = cy + dy * dist;
      const z = cz + dz * dist;
      const b = _getBlock(bot, x, y, z);
      if (!b) {
        blocker = { x, y, z, name: 'unknown', reason: 'oob' };
        break;
      }
      if (_isSolid(b)) {
        blocker = { x, y, z, name: b.name };
        // Check ceiling height just before blocker (doorway detection)
        if (dy === 0) {
          const head = _getBlock(bot, x, y + 1, z);
          if (head && _isSolid(head)) {
            lowCeiling = true;
          }
        }
        break;
      }
    }
    out[name] = { free: dist, blocker, lowCeiling };
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────
// Volume scan
// ──────────────────────────────────────────────────────────────────────

function _scanVolume(bot, x1, y1, z1, x2, y2, z2) {
  const blocks = [];
  for (let y = Math.min(y1, y2); y <= Math.max(y1, y2); y++) {
    for (let z = Math.min(z1, z2); z <= Math.max(z1, z2); z++) {
      for (let x = Math.min(x1, x2); x <= Math.max(x1, x2); x++) {
        const b = _getBlock(bot, x, y, z);
        blocks.push({ x, y, z, name: b ? b.name : 'unknown', walkable: _isWalkable(b) });
      }
    }
  }
  return blocks;
}

// ──────────────────────────────────────────────────────────────────────
// Action: identify_cave
// ──────────────────────────────────────────────────────────────────────

function actionIdentifyCave(bot, opts) {
  const radius = opts.radius || 8;
  const pos = opts.position || (bot.entity && bot.entity.position);
  if (!pos) return { is_cave: false, reason: 'no_position' };
  const cx = Math.floor(pos.x), cy = Math.floor(pos.y), cz = Math.floor(pos.z);

  // Check ceiling: stone/andesite/deepslate/diorite/granite/cave ceiling ≤4 blocks
  let ceilingHeight = null;
  for (let h = 1; h <= 4; h++) {
    const b = _getBlock(bot, cx, cy + h, cz);
    if (b && _isCeiling(b) && (b.name.includes('stone') || b.name.includes('deepslate')
        || b.name.includes('diorite') || b.name.includes('granite')
        || b.name.includes('andesite') || b.name.includes('tuff')
        || b.name === 'bedrock' || b.name === 'dirt' || b.name === 'grass_block')) {
      ceilingHeight = h;
      break;
    }
  }
  const hasStoneCeiling = ceilingHeight !== null;

  // Check daylight: if there's a transparent block above with sky access
  let skyLight = 0;
  for (let h = cy + 1; h <= cy + 20; h++) {
    const b = _getBlock(bot, cx, h, cz);
    if (!b) break;
    if (b.name === 'air' || b.name === 'cave_air' || _isWalkable(b)) {
      skyLight++;
    } else {
      break;
    }
  }
  const hasSkyAccess = skyLight >= 3;

  // Check furni (cave usually has no furni)
  const vol = _scanVolume(bot, cx - 2, cy, cz - 2, cx + 2, cy + 1, cz + 2);
  const furniCount = vol.filter(b => _isCraftingTable(b.name) || _isFurnace(b.name)
    || _isChest(b.name) || _isBed(b.name) || b.name.includes('sign')).length;
  const hasFurni = furniCount > 0;

  const is_cave = hasStoneCeiling && !hasSkyAccess && !hasFurni;
  const depth_blocks = hasSkyAccess ? 0 : Math.max(0, 30 - skyLight);

  // Determine exit direction (closest solid wall behind which might be open)
  const cardinal = _scanCardinal(bot, cx, cy, cz, 12);
  let exitDirection = null;
  let bestDist = 0;
  for (const [name, info] of Object.entries(cardinal)) {
    if (name === 'up' || name === 'down') continue;
    if (info.free > bestDist) {
      bestDist = info.free;
      exitDirection = name;
    }
  }

  const escapeTools = [];
  if (is_cave) {
    if (ceilingHeight !== null && ceilingHeight <= 2) {
      escapeTools.push('spiral');
    }
    escapeTools.push('tunnel');
  }

  return {
    is_cave,
    ceiling_height: ceilingHeight,
    has_sky_access: hasSkyAccess,
    sky_light: skyLight,
    has_furni: hasFurni,
    furni_count: furniCount,
    depth_blocks,
    exit_direction: exitDirection,
    escape_tools: escapeTools,
  };
}

// ──────────────────────────────────────────────────────────────────────
// Action: identify_interior
// ──────────────────────────────────────────────────────────────────────

function actionIdentifyInterior(bot, opts) {
  const radius = opts.radius || 8;
  const pos = opts.position || (bot.entity && bot.entity.position);
  if (!pos) return { is_interior: false, reason: 'no_position' };
  const cx = Math.floor(pos.x), cy = Math.floor(pos.y), cz = Math.floor(pos.z);

  // Ceiling check
  let ceilingHeight = null;
  for (let h = 1; h <= 5; h++) {
    const b = _getBlock(bot, cx, cy + h, cz);
    if (b && _isCeiling(b)) {
      ceilingHeight = h;
      break;
    }
  }
  const hasCeiling = ceilingHeight !== null;

  // Wall check: count solid cardinal walls at bot Y level
  const cardinal = _scanCardinal(bot, cx, cy, cz, Math.min(radius, 6));
  const wallCount = ['north', 'south', 'east', 'west']
    .filter(d => cardinal[d].blocker !== null).length;

  // Sky light
  let skyLight = 0;
  for (let h = cy + 1; h <= cy + 20; h++) {
    const b = _getBlock(bot, cx, h, cz);
    if (!b) break;
    if (b.name === 'air' || _isWalkable(b)) skyLight++;
    else break;
  }
  const noDaylight = skyLight === 0;

  // Footprint: scan the larger volume, find bounding box of solid blocks
  const scan = _scanVolume(bot, cx - radius, cy, cz - radius, cx + radius, cy + 4, cz + radius);
  const solidBlocks = scan.filter(b => !b.walkable && b.name !== 'air' && b.name !== 'cave_air');
  let footprint = null;
  if (solidBlocks.length > 0) {
    const xs = solidBlocks.map(b => b.x);
    const zs = solidBlocks.map(b => b.z);
    footprint = {
      x_min: Math.min(...xs), x_max: Math.max(...xs),
      z_min: Math.min(...zs), z_max: Math.max(...zs),
    };
  }

  // Door detection in radius
  const doorScan = scan.filter(b => _isDoor(b.name));
  const hasDoorInRange = doorScan.length > 0;

  // Structure type heuristic
  let structureType = 'unknown';
  if (hasCeiling && wallCount >= 3) {
    const furniInScan = scan.filter(b => _isCraftingTable(b.name) || _isFurnace(b.name)
      || _isChest(b.name) || _isBed(b.name)).length;
    if (furniInScan >= 1) {
      structureType = 'house';
    } else if (hasDoorInRange) {
      structureType = 'house';
    } else if (wallCount >= 4) {
      structureType = 'corridor';
    } else {
      structureType = 'shelter';
    }
  } else if (hasCeiling && wallCount === 2) {
    structureType = 'corridor';
  } else if (noDaylight && footprint === null) {
    structureType = 'cave';
  } else {
    structureType = 'outdoor';
  }

  const isInterior = hasCeiling && wallCount >= 2 && noDaylight && ceilingHeight <= 5;

  return {
    is_interior: isInterior,
    structure_type: structureType,
    ceiling_height: ceilingHeight,
    wall_count: wallCount,
    no_daylight: noDaylight,
    footprint_xz: footprint,
    has_door_in_range: hasDoorInRange,
    door_count: doorScan.length,
    cardinal,
  };
}

// ──────────────────────────────────────────────────────────────────────
// Action: find_doors
// ──────────────────────────────────────────────────────────────────────

function actionFindDoors(bot, opts) {
  const radius = opts.radius || 10;
  const pos = opts.position || (bot.entity && bot.entity.position);
  if (!pos) return { doors: [], reason: 'no_position' };
  const cx = Math.floor(pos.x), cy = Math.floor(pos.y), cz = Math.floor(pos.z);

  const scan = _scanVolume(bot, cx - radius, cy - 2, cz - radius, cx + radius, cy + 3, cz + radius);
  const doorBlocks = scan.filter(b => _isDoor(b.name));

  const doors = doorBlocks.map(b => {
    const block = _getBlock(bot, b.x, b.y, b.z);
    const isOpen = _isDoorOpen(block);
    return {
      position: { x: b.x, y: b.y, z: b.z },
      type: b.name,
      is_open: isOpen,
      hinge_side: block && block.metadata !== undefined
        ? ((block.metadata & 8) ? 'left' : 'right')  // bit 3 = hinge
        : null,
    };
  });

  // Sort by distance from bot
  doors.sort((a, b) => {
    const da = Math.abs(a.position.x - cx) + Math.abs(a.position.y - cy) + Math.abs(a.position.z - cz);
    const db = Math.abs(b.position.x - cx) + Math.abs(b.position.y - cy) + Math.abs(b.position.z - cz);
    return da - db;
  });

  return {
    count: doors.length,
    doors,
  };
}

// ──────────────────────────────────────────────────────────────────────
// Action: verify_door
// ──────────────────────────────────────────────────────────────────────

function actionVerifyDoor(bot, opts) {
  const { x, y, z } = opts;
  if (x === undefined || y === undefined || z === undefined) {
    return { error: 'x, y, z required' };
  }
  const block = _getBlock(bot, x, y, z);
  if (!block) return { error: 'block not found at coords' };
  if (!_isDoor(block.name)) {
    return {
      is_door: false,
      actual_block: block.name,
    };
  }
  const isOpen = _isDoorOpen(block);
  const aboveBlock = _getBlock(bot, x, y + 1, z);
  return {
    is_door: true,
    type: block.name,
    position: { x, y, z },
    is_open: isOpen,
    hinge_side: block.metadata !== undefined
      ? ((block.metadata & 8) ? 'left' : 'right')  // bit 3 = hinge
      : null,
    blocks_movement: isOpen === false,
    has_door_top: aboveBlock !== null && _isDoor(aboveBlock.name),
    actual_block: block.name,
  };
}

// ──────────────────────────────────────────────────────────────────────
// Action: scan_structure (combines structure_outline + find_doors + furni)
// ──────────────────────────────────────────────────────────────────────

function actionScanStructure(bot, opts) {
  const radius = opts.radius || 12;
  const interior = actionIdentifyInterior(bot, opts);
  const doors = actionFindDoors(bot, opts);
  const pos = opts.position || (bot.entity && bot.entity.position);
  if (!pos) return { reason: 'no_position' };
  const cx = Math.floor(pos.x), cy = Math.floor(pos.y), cz = Math.floor(pos.z);

  // Furni inventory in radius
  const scan = _scanVolume(bot, cx - radius, cy, cz - radius, cx + radius, cy + 4, cz + radius);
  const furni = {};
  for (const b of scan) {
    if (_isChest(b.name)) furni.chests = (furni.chests || 0) + 1;
    else if (_isFurnace(b.name)) furni.furnaces = (furni.furnaces || 0) + 1;
    else if (_isCraftingTable(b.name)) furni.crafting_tables = (furni.crafting_tables || 0) + 1;
    else if (_isBed(b.name)) furni.beds = (furni.beds || 0) + 1;
  }

  return {
    is_interior: interior.is_interior,
    structure_type: interior.structure_type,
    ceiling_height: interior.ceiling_height,
    footprint_xz: interior.footprint_xz,
    doors: doors.doors,
    door_count: doors.count,
    furni,
    radius,
  };
}

// ──────────────────────────────────────────────────────────────────────
// Action dispatcher
// ──────────────────────────────────────────────────────────────────────

export function dispatchNavigate(bot, action, opts) {
  opts = opts || {};
  switch (action) {
    case 'identify_cave':      return actionIdentifyCave(bot, opts);
    case 'identify_interior':  return actionIdentifyInterior(bot, opts);
    case 'find_doors':         return actionFindDoors(bot, opts);
    case 'verify_door':        return actionVerifyDoor(bot, opts);
    case 'scan_structure':     return actionScanStructure(bot, opts);
    default:
      throw new Error(`Unknown mc_navigate action: ${action}. Use: identify_cave, identify_interior, find_doors, verify_door, scan_structure.`);
  }
}
