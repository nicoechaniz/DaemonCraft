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
    // Tied to t_d7b663f3 (chunk loading). mineflayer's blockAt() returns
    // null for chunks that haven't been loaded into the bot's world.
    // We force-load the chunk for (x, z) before reading. This makes the
    // mc_navigate queries work for arbitrary positions, not just the
    // bot's currently-loaded area.
    if (bot && bot.world && typeof bot.world.loadChunk === 'function') {
      try {
        const cx = x >> 4;  // block → chunk
        const cz = z >> 4;
        const loaded = bot.world.getColumn && bot.world.getColumn(cx, cz);
        if (!loaded) {
          bot.world.loadChunk(cx, cz);  // sync request — populates the column
        }
      } catch (_le) {
        // loadChunk is best-effort. If it fails, fall through to
        // blockAt which will return null and we treat as 'unknown'.
      }
    }
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
// Safety assessment (t_dd9f607d)
// ──────────────────────────────────────────────────────────────────────

// Issues that make a structure unsafe for sleeping. NOT issues: missing_bed,
// missing_chest, low_artificial_light (those are preferences, not safety hazards).
const SAFETY_ISSUE_TOKENS = [
  'open_door',         // open door = mobs can enter
  'wall_hole',         // gap in the wall = mobs can enter
  'missing_floor',     // hole in the floor = bot could fall
  'lava_within_5m',    // lava close by
  'hostile_inside',    // hostile mob inside the structure
  'low_light_and_hostile',  // low light + hostiles visible = spawn risk
];

/**
 * Evaluate a set of access points + missing blocks + hostile presence
 * and return {is_safe, safety_issues[]}. The default issues list focuses
 * on actual safety hazards (mobs entering, falling, burning) NOT on
 * preferences (missing bed, no chest).
 */
function _assessSafety(accessPoints, missingBlocks, hostilePresence, lavaNearby, lowLight, hostilesInside) {
  const issues = [];
  for (const ap of accessPoints) {
    if (ap.type === 'door' && ap.is_open) {
      issues.push(`open_door_at_[${ap.position.x},${ap.position.y},${ap.position.z}]`);
    }
    if (ap.type === 'hole' && ap.is_blocking === false && ap.width >= 1) {
      issues.push(`wall_hole_${ap.width}x${ap.width}_at_[${ap.position.x},${ap.position.y},${ap.position.z}]`);
    }
  }
  for (const mb of missingBlocks) {
    if (mb.expected === 'floor') {
      issues.push(`missing_floor_at_[${mb.position.x},${mb.position.y},${mb.position.z}]`);
    } else if (mb.expected === 'wall' && mb.size_blocks >= 1) {
      // wall holes are already in access_points
    }
  }
  if (lavaNearby) {
    issues.push('lava_within_5m');
  }
  if (hostilesInside && hostilesInside.length > 0) {
    issues.push(`hostile_inside_count_${hostilesInside.length}`);
  }
  if (lowLight && hostilePresence) {
    issues.push('low_light_with_hostile_nearby');
  }
  return {
    is_safe: issues.length === 0,
    safety_issues: issues,
  };
}

/**
 * Find "missing" blocks in a wall/ceiling/floor — i.e. air blocks where
 * a solid block was expected. Returns a list of {position, expected, current, size_blocks}.
 * Directly actionable: each entry is a place to mc_build place to seal the structure.
 */
function _findMissingBlocks(scan, footprint, ceilingY) {
  if (!footprint) return [];
  const out = [];
  for (const b of scan) {
    // Wall position: x is at min/max OR z is at min/max, y is in body range
    const isWallX = (b.x === footprint.x_min || b.x === footprint.x_max);
    const isWallZ = (b.z === footprint.z_min || b.z === footprint.z_max);
    if (!isWallX && !isWallZ) continue;
    if (b.name === 'air' || b.name === 'cave_air') {
      out.push({
        position: { x: b.x, y: b.y, z: b.z },
        expected: 'wall',
        current: b.name,
        size_blocks: 1,
      });
    }
  }
  return out;
}

/**
 * Find access points: doors + holes in walls/ceiling.
 * Returns [{type, block, position, is_open|is_blocking, width}].
 */
function _findAccessPoints(scan, footprint) {
  if (!footprint) return [];
  const out = [];
  for (const b of scan) {
    if (_isDoor(b.name)) {
      const block = _getBlock(bot, b.x, b.y, b.z);
      const isOpen = _isDoorOpen(block);
      out.push({
        type: 'door',
        block: b.name,
        position: { x: b.x, y: b.y, z: b.z },
        is_open: isOpen,
        is_blocking: !isOpen,  // closed doors block movement
        width: 1,
      });
    } else if (b.name === 'air' || b.name === 'cave_air') {
      const isWallX = (b.x === footprint.x_min || b.x === footprint.x_max);
      const isWallZ = (b.z === footprint.z_min || b.z === footprint.z_max);
      if (isWallX || isWallZ) {
        out.push({
          type: 'hole',
          block: b.name,
          position: { x: b.x, y: b.y, z: b.z },
          is_open: true,
          is_blocking: false,  // air doesn't block movement
          width: 1,
        });
      }
    }
  }
  return out;
}

/**
 * Count furni by type in a scan. Returns {chests, furnaces, crafting_tables, beds, doors, torches, lights_total}.
 */
function _countFurni(scan) {
  const out = { chests: 0, furnaces: 0, crafting_tables: 0, beds: 0, doors: 0, torches: 0, lights_total: 0 };
  for (const b of scan) {
    if (_isChest(b.name)) out.chests++;
    else if (_isFurnace(b.name)) out.furnaces++;
    else if (_isCraftingTable(b.name)) out.crafting_tables++;
    else if (_isBed(b.name)) out.beds++;
    else if (_isDoor(b.name)) out.doors++;
    else if (b.name === 'torch' || b.name === 'wall_torch' || b.name === 'soul_torch' ||
             b.name === 'lantern' || b.name === 'soul_lantern' || b.name === 'campfire' ||
             b.name === 'soul_campfire' || b.name === 'jack_o_lantern' || b.name === 'glowstone' ||
             b.name === 'shroomlight' || b.name === 'sea_lantern' || b.name === 'redstone_lamp' ||
             b.name === 'froglight' || b.name === 'ochre_froglight' || b.name === 'verdant_froglight' ||
             b.name === 'pearlescent_froglight' || b.name === 'candle' || b.name.endsWith('_candle')) {
      out.torches++;
      out.lights_total++;
    } else if (b.name === 'glowstone' || b.name === 'shroomlight' || b.name === 'sea_lantern' ||
               b.name === 'redstone_lamp' || b.name === 'froglight' || b.name === 'ochre_froglight' ||
               b.name === 'verdant_froglight' || b.name === 'pearlescent_froglight') {
      out.lights_total++;
    }
  }
  return out;
}

/**
 * Check if there are hostile mobs inside the structure.
 * Reads bot.entities and filters by type=hostile + position inside footprint.
 */
function _hostilesInside(bot, footprint) {
  if (!bot || !bot.entities || !footprint) return [];
  const hostileTypes = new Set(['zombie', 'skeleton', 'creeper', 'spider', 'enderman', 'witch',
                                 'slime', 'phantom', 'drowned', 'husk', 'stray', 'cave_spider',
                                 'silverfish', 'blaze', 'piglin', 'hoglin', 'zoglin', 'guardian',
                                 'elder_guardian', 'ravager', 'pillager', 'vindicator', 'evoker',
                                 'vex', 'wither_skeleton']);
  const out = [];
  for (const ent of Object.values(bot.entities)) {
    if (ent === bot.entity || !ent.position) continue;
    const ex = Math.floor(ent.position.x);
    const ey = Math.floor(ent.position.y);
    const ez = Math.floor(ent.position.z);
    if (ex < footprint.x_min || ex > footprint.x_max) continue;
    if (ez < footprint.z_min || ez > footprint.z_max) continue;
    const name = ent.name || ent.username || '';
    if (hostileTypes.has(name)) {
      out.push({
        type: name,
        position: { x: ex, y: ey, z: ez },
        distance: Math.abs(ex - Math.floor(ent.position.x)) + Math.abs(ey - Math.floor(ent.position.y)) + Math.abs(ez - Math.floor(ent.position.z)),
      });
    }
  }
  return out;
}

/**
 * Check if there's lava within 5 blocks of the bot.
 */
function _lavaNearby(bot, pos, radius) {
  radius = radius || 5;
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dz = -radius; dz <= radius; dz++) {
        if (dx*dx + dy*dy + dz*dz > radius*radius) continue;
        const b = _getBlock(bot, pos.x + dx, pos.y + dy, pos.z + dz);
        if (b && (b.name === 'lava' || b.name === 'flowing_lava')) return true;
      }
    }
  }
  return false;
}

// ──────────────────────────────────────────────────────────────────────
// Action: identify_interior (ENRICHED — t_dd9f607d)
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

  // Wall check
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

  // Full volume scan for footprint + access_points + missing_blocks + furni
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

  // Enriched fields (t_dd9f607d)
  const accessPoints = _findAccessPoints(scan, footprint);
  const missingBlocks = _findMissingBlocks(scan, footprint, ceilingHeight);
  const furni = _countFurni(scan);
  const hostilesInside = _hostilesInside(bot, footprint);
  const hostilePresence = hostilesInside.length > 0;
  const lava = _lavaNearby(bot, { x: cx, y: cy, z: cz }, 5);
  const lowLight = furni.torches === 0 && furni.lights_total === 0;

  // Structure type heuristic
  let structureType = 'unknown';
  if (hasCeiling && wallCount >= 3) {
    const furniInScan = furni.chests + furni.furnaces + furni.crafting_tables + furni.beds;
    if (furniInScan >= 1) {
      structureType = 'house';
    } else if (accessPoints.some(ap => ap.type === 'door')) {
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

  // Safety (only meaningful if we're actually inside)
  const safety = isInterior
    ? _assessSafety(accessPoints, missingBlocks, hostilePresence, lava, lowLight, hostilesInside)
    : { is_safe: null, safety_issues: [] };

  // Volume in blocks
  const volumeBlocks = footprint
    ? (footprint.x_max - footprint.x_min + 1) * (footprint.z_max - footprint.z_min + 1) * (ceilingHeight || 3)
    : 0;

  return {
    // Original fields (back-compat)
    is_interior: isInterior,
    structure_type: structureType,
    ceiling_height: ceilingHeight,
    wall_count: wallCount,
    no_daylight: noDaylight,
    footprint_xz: footprint,
    has_door_in_range: accessPoints.some(ap => ap.type === 'door'),
    door_count: accessPoints.filter(ap => ap.type === 'door').length,
    cardinal,
    // Enriched fields (t_dd9f607d)
    volume_blocks: volumeBlocks,
    access_points: accessPoints,
    missing_blocks: missingBlocks,
    furni: furni,
    hostile_presence: hostilePresence,
    hostiles_inside: hostilesInside,
    is_safe: safety.is_safe,
    safety_issues: safety.safety_issues,
    radius,
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
      is_blocking: !isOpen,  // closed doors block movement
      blocks_movement: !isOpen,  // alias for back-compat
      hinge_side: block && block.metadata !== undefined
        ? ((block.metadata & 8) ? 'left' : 'right')
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
// Action: verify_door (ENRICHED — t_063009f4 + t_dd9f607d)
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
      position: { x, y, z },
      block: block.name,
      category: _categoryForBlock(block.name),
      is_solid: _isSolid(block),
    };
  }
  const isOpen = _isDoorOpen(block);
  const aboveBlock = _getBlock(bot, x, y + 1, z);
  return {
    is_door: true,
    type: block.name,
    position: { x, y, z },
    is_open: isOpen,
    is_blocking: !isOpen,
    blocks_movement: !isOpen,  // alias
    hinge_side: block.metadata !== undefined
      ? ((block.metadata & 8) ? 'left' : 'right')
      : null,
    has_door_top: aboveBlock !== null && _isDoor(aboveBlock.name),
    actual_block: block.name,
    category: _categoryForBlock(block.name),
  };
}

// ──────────────────────────────────────────────────────────────────────
// Action: scan_structure (ENRICHED — t_dd9f607d)
// ──────────────────────────────────────────────────────────────────────

function actionScanStructure(bot, opts) {
  const radius = opts.radius || 12;
  const pos = opts.position || (bot.entity && bot.entity.position);
  if (!pos) return { reason: 'no_position' };
  const cx = Math.floor(pos.x), cy = Math.floor(pos.y), cz = Math.floor(pos.z);

  // Use the enriched identify_interior (already computes access_points,
  // missing_blocks, furni, hostiles, is_safe, etc.)
  const interior = actionIdentifyInterior(bot, opts);
  const doors = actionFindDoors(bot, opts);

  return {
    is_interior: interior.is_interior,
    structure_type: interior.structure_type,
    ceiling_height: interior.ceiling_height,
    footprint_xz: interior.footprint_xz,
    volume_blocks: interior.volume_blocks,
    access_points: interior.access_points,
    missing_blocks: interior.missing_blocks,
    furni: interior.furni,
    hostile_presence: interior.hostile_presence,
    hostiles_inside: interior.hostiles_inside,
    is_safe: interior.is_safe,
    safety_issues: interior.safety_issues,
    doors: doors.doors,
    door_count: doors.count,
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
    case 'verify_block':       return actionVerifyBlock(bot, opts);
    default:
      throw new Error(`Unknown mc_navigate action: ${action}. Use: identify_cave, identify_interior, find_doors, verify_door, scan_structure, verify_block.`);
  }
}

// ──────────────────────────────────────────────────────────────────────
// Action: verify_block (t_063009f4)
// Companion to the type-based CJK mapping: when the LLM sees a char like
// 瓦 (tile) in the visual and wants the EXACT block name, it can call
// this with the position to get the full block identity. Fills the
// 10% gap that the type-based CJK intentionally leaves ambiguous.
// ──────────────────────────────────────────────────────────────────────

function _categoryForBlock(name) {
  if (!name) return 'unknown';
  if (_isDoor(name)) return 'door';
  if (_isChest(name)) return 'chest';
  if (_isFurnace(name)) return 'furnace';
  if (_isCraftingTable(name)) return 'crafting_table';
  if (_isBed(name)) return 'bed';
  if (_isGlass(name)) return 'glass';
  if (_isStair(name)) return 'stair';
  if (_isTrapdoor(name)) return 'trapdoor';
  if (name === 'water' || name === 'flowing_water') return 'water';
  if (name === 'lava' || name === 'flowing_lava') return 'lava';
  if (name === 'air' || name === 'cave_air' || name === 'void_air') return 'air';
  if (name === 'torch' || name === 'wall_torch' || name === 'soul_torch') return 'torch';
  return 'other';
}

function actionVerifyBlock(bot, opts) {
  const { x, y, z } = opts;
  if (x === undefined || y === undefined || z === undefined) {
    return { error: 'x, y, z required' };
  }
  const block = _getBlock(bot, x, y, z);
  if (!block) return { error: 'block not found at coords (chunk not loaded or out of range)' };
  return {
    position: { x, y, z },
    block: block.name,
    category: _categoryForBlock(block.name),
    is_solid: _isSolid(block),
    is_walkable: _isWalkable(block),
    is_opaque: _isCeiling(block),
    metadata: block.metadata !== undefined ? block.metadata : null,
  };
}
