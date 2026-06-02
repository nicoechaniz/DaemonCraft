/**
 * world_state composer: reads bot/server.js endpoints and produces the
 * canonical 7-key (+ optional) shape Gemma-Andy expects.
 *
 * Per the team docs (raw/gemma-andy/gemma-andy-integration-guide.md),
 * canonical keys are: time_of_day, bot_position, player_position,
 * nearby_blocks, nearby_entities, hazards, inventory.
 * Optional: server_type, zone_owner, world_text_artifacts.
 *
 * The bot server's response shape is `{ok: true, data: {...}}` per the
 * existing handler convention; we unwrap `.data`.
 */
const DEFAULT_BOT_URL = process.env.BOT_API_URL || "http://localhost:3001";

async function botGet(path, botUrl = null) {
  const base = botUrl || DEFAULT_BOT_URL;
  const res = await fetch(`${base}${path}`);
  if (!res.ok) {
    throw new Error(`bot/server.js GET ${path} → ${res.status}`);
  }
  const json = await res.json();
  return json.data ?? json;
}

// Tied to t_528a7941 (2026-06-02). Bot server `/blocks?format=visual`
// now emits **type-based CJK** characters instead of the legacy
// binary/surface/columns/full/rows formats. The bot server returns
// 400 for any other format. The legend here tells the model what
// the CJK chars mean and how to read them. The CJK chars have
// semantic meaning in Chinese/Japanese (e.g. 瓦=tile/terracotta,
// 木=log, 葉=leaf, 土=earth, 岩=rock) so a CJK-literate LLM can
// decode them without the legend.
const MBIT_LEGEND = [
  "Format: type-based CJK visual. 1 char per block, 146 distinct chars total.",
  "Mnemonic overrides: space=air, ~=water, !=lava, comma=short_grass, semicolon=tall_grass, dagger=torches, lozenge=lanterns, R=redstone_wire.",
  "Walkable blocks (use these to decide where the bot can stand): space, ~, !, comma, semicolon, dagger, lozenge, and CJK chars mapped to other plants/leaves.",
  "The remaining blocks are emitted as semantic CJK chars: 瓦=tile/terracotta, 扉=door, 階=stairs, 硝=glass, 幹=log/trunk, 板=plank/board, 葉=leaf, 花=flower, 苗=sapling, 草=grass, 種=seed, 菌=mushroom, 砂=sand, 土=earth/dirt, 岩=rock, 丸=cobblestone, 水=water, 火=fire, 空=sky/air, 光=light, 暗=dark, 禁=forbidden (barrier), 銅=copper, 鉄=iron, 金=gold, 紫=amethyst, 霊=soul, 獄=netherrack.",
  "For exact block identification of a CJK char, refer to the legend at the bottom of each scan which shows the first block name that char maps to plus a (+N more) suffix when the char is a category covering multiple blocks.",
  "Use mc_navigate(action=verify_block, x=..., y=..., z=...) for the 10% case where you need to distinguish e.g. yellow_terracotta from brown_terracotta (both map to 瓦).",
].join(" ");

function classifyMbitPurpose(intent = "") {
  const low = String(intent || "").toLowerCase();
  if (/\b(verify|check|confirm|diff|before|after|revis|comprob|verific)\b/.test(low)) return "verification";
  if (/\b(mine|minar|dig|excavat|gather|collect|consegu|ore|stone|coal|iron)\b/.test(low)) return "mining";
  if (/\b(build|place|constru|poner|pon[eé]|farm|till|plant|wall|shelter|bridge)\b/.test(low)) return "building";
  if (/\b(go|goto|move|walk|follow|come|approach|ven|and[aá]|camina|acerc|alejat|avoid|path|navigate)\b/.test(low)) return "navigation";
  return "local_context";
}

function chooseMbitSpec(botPos, intent = "") {
  const [x, y, z] = botPos;
  const purpose = classifyMbitPurpose(intent);
  const mkBounds = (radius, yBelow, yAbove) => ({
    x1: x - radius,
    y1: y - yBelow,
    z1: z - radius,
    x2: x + radius,
    y2: y + yAbove,
    z2: z + radius,
  });
  const grid = (format, bounds) => ({ format, bounds });

  if (purpose === "verification") {
    return {
      purpose,
      grids: [grid("visual", { x1: x - 1, y1: y - 1, z1: z - 1, x2: x + 2, y2: y + 2, z2: z + 2 })],
      interpretation_hint: "Use this 4x4x4 visual voxel sample for exact before/after local verification. The visual format is Y-major: top layer first, then north->south rows and west->east characters. Each CJK char has a semantic meaning; see MBIT_LEGEND at the bottom of each grid for the inverse mapping.",
    };
  }
  if (purpose === "mining") {
    return {
      purpose,
      grids: [
        grid("visual", mkBounds(4, 3, 5)),
        grid("visual", mkBounds(4, 0, 5)),
        grid("visual", mkBounds(4, 0, 5)),
      ],
      interpretation_hint: "For mining/digging, the 3 visual grids show vertical clearance, ground type, and free-distance horizons around the bot. Each grid is a Y-major text representation; read top-to-bottom and the legend at the bottom maps each CJK char to its block name. Prefer scan/find tools for exact target coordinates after reading the visual terrain cue.",
    };
  }
  if (purpose === "building") {
    return {
      purpose,
      grids: [
        grid("visual", mkBounds(5, 1, 4)),
        grid("visual", mkBounds(5, 0, 1)),
        grid("visual", mkBounds(5, 0, 4)),
      ],
      interpretation_hint: "For building/placing, the 3 visual grids show the floor/material under each cell, blocked-vs-walkable footprint, and free distance. Walkable blocks (space, ~, !, comma, semicolon, dagger, lozenge) are safe to stand on. Keep the bot near the center and avoid placing into blocked cells unless intentionally building there.",
    };
  }
  return {
    purpose,
    grids: [
      grid("visual", mkBounds(4, 0, 1)),
      grid("visual", mkBounds(4, 1, 3)),
      grid("visual", mkBounds(4, 0, 3)),
    ],
    interpretation_hint: "For navigation, the 3 visual grids show: blocked-vs-walkable footprint, ground material, and free distance in N/S/E/W/Up/Down. Walkable blocks (space, ~, !, comma, semicolon, dagger, lozenge) are where the bot can move. The CJK char-to-block mapping is at the bottom of each grid (the legend).",
  };
}

async function fetchMbitContext(botPos, intent = "", botUrl = null) {
  const spec = chooseMbitSpec(botPos, intent);
  const grids = await Promise.all(spec.grids.map(async ({ format, bounds }) => {
    const q = new URLSearchParams({
      x1: String(bounds.x1),
      y1: String(bounds.y1),
      z1: String(bounds.z1),
      x2: String(bounds.x2),
      y2: String(bounds.y2),
      z2: String(bounds.z2),
      cx: String(botPos[0]),
      cz: String(botPos[2]),
      format,
    });
    const data = await botGet(`/blocks?${q.toString()}`, botUrl);
    return {
      format,
      bounds,
      count: data.count ?? null,
      elapsed_ms: data.elapsed_ms ?? null,
      text: data.text ?? "",
    };
  }));
  return {
    purpose: spec.purpose,
    center: { x: botPos[0], y: botPos[1], z: botPos[2] },
    legend: MBIT_LEGEND,
    interpretation_hint: spec.interpretation_hint,
    grids,
  };
}

function mapTimeOfDay(timeTicks) {
  // Minecraft day is 0..23999. Sunset around 12000-13000, night 13000-23000,
  // dawn 23000-24000. Map to the three labels the model was trained on.
  if (timeTicks == null) return "day";
  const t = Number(timeTicks);
  if (t >= 11500 && t < 13500) return "sunset";
  if (t >= 13500 && t < 23000) return "night";
  return "day";
}

/**
 * Compose a canonical world_state for Gemma-Andy.
 *
 * Returns an object with the 7 required keys + 2 optional ones. Missing
 * fields from bot/server.js degrade to safe defaults rather than throwing —
 * the model tolerates absence of optional fields, and an empty
 * nearby_blocks (etc.) is valid input.
 */
export async function composeWorldState({ extra = {}, botUrl = null, intent = "" } = {}) {
  // Issue reads in parallel. /status gives biome, health, hunger, time;
  // /nearby gives blocks + entities (radius 64 to catch players further
  // out); /inventory gives items.
  const [status, nearby, inventory] = await Promise.all([
    botGet("/status", botUrl),
    botGet("/nearby?radius=64", botUrl),
    botGet("/inventory", botUrl),
  ]);

  // status: { position: {x,y,z}, time, health, food, ... }
  // nearby: { blocks: [...], entities: [...], hazards: [...], player_position: {x,y,z} }
  // inventory: { items: {oak_log: 5, ...} } OR list of item entries

  // Coordinates as integers — training distribution uses block coords
  // (e.g. [10, 68, 5], not [10.5, 68.0, 5.3]). Field-test 2026-05-09
  // surfaced that floats produced fabricated goto targets ([1, 64, 518]
  // for an actual position [27.3, 79, 56.5]).
  const botPos = status?.position
    ? [Math.floor(status.position.x), Math.floor(status.position.y), Math.floor(status.position.z)]
    : [0, 64, 0];
  // The bot's /nearby response does NOT include a top-level
  // `player_position` field. Players appear inside `entities` with
  // `kind: "player"`. Pick the closest one as the canonical
  // `world_state.player_position`. Field-test 2026-05-09 surfaced this
  // composer gap when a "come here" intent received player_position=null
  // even though the player was in-world.
  let playerPos = nearby?.player_position
    ? [nearby.player_position.x, nearby.player_position.y, nearby.player_position.z]
    : null;
  if (!playerPos && Array.isArray(nearby?.entities)) {
    const players = nearby.entities
      .filter((e) => e?.kind === "player" || e?.type === "player")
      .filter((e) => e?.position && typeof e.position.x === "number");
    if (players.length) {
      players.sort((a, b) => (a.distance ?? 1e9) - (b.distance ?? 1e9));
      const p = players[0].position;
      playerPos = [Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)];
    }
  }

  // Inventory MUST be sent as a flat {name: count} dict per the
  // canonical schema (raw/gemma-andy/gemma-andy-integration-guide.md
  // examples). Field-test 2026-05-09 surfaced that we were sending
  // the bot's nested {categories: {blocks: [...], materials: [...]},
  // totalSlots: N} shape — the model never saw oak_planks as a top-level
  // key and fell back to its prior (oak_log), which manifested as the
  // "inventory_ignorance" regression. Flatten everything into {name: count}.
  const invDict = {};
  function _addItem(it) {
    if (it?.name && (it.count ?? 0) > 0) {
      invDict[it.name] = (invDict[it.name] ?? 0) + it.count;
    }
  }
  if (inventory?.categories && typeof inventory.categories === "object") {
    // Bot's actual shape: { categories: { blocks: [...], materials: [...], ... }, totalSlots }
    for (const list of Object.values(inventory.categories)) {
      if (Array.isArray(list)) list.forEach(_addItem);
    }
  } else if (Array.isArray(inventory?.items)) {
    inventory.items.forEach(_addItem);
  } else if (inventory?.items && typeof inventory.items === "object") {
    Object.assign(invDict, inventory.items);
  } else if (inventory && typeof inventory === "object" && !Array.isArray(inventory)) {
    // Best-effort: if it already looks like {name: count}, pass through.
    // Skip non-numeric values (categories, totalSlots, etc).
    for (const [k, v] of Object.entries(inventory)) {
      if (typeof v === "number") invDict[k] = v;
    }
  }

  // Per the integration guide examples (raw/gemma-andy/gemma-andy-
  // integration-guide.md) the canonical training shape for nearby_blocks
  // and nearby_entities is a flat list of strings — block type names
  // and entity type names — NOT the rich {name, count, nearest} or
  // {type, distance, position, kind} objects the bot returns. Field-
  // test 2026-05-09 surfaced that sending the rich objects made the
  // model fall back to its prior (oak_log default) because nothing in
  // the input matched the training distribution. Flatten to canonical
  // strings; the model has scan_nearby + find_blocks tools to query
  // for details when it needs them.
  const blockNames = Array.isArray(nearby?.blocks)
    ? Array.from(new Set(nearby.blocks.map((b) => b?.name).filter(Boolean)))
    : [];
  // Filter nearby_entities to types the model was trained on: mobs,
  // players, animals. Drop noise like dropped-item entities, minecarts,
  // particle effects, etc. The training distribution uses bare type
  // strings ("zombie", "player", "skeleton") not Mineflayer internals.
  const ENTITY_NOISE = new Set([
    "item", "experience_orb", "arrow", "snowball", "egg",
    "chest_minecart", "minecart", "boat", "tnt",
    "leash_knot", "armor_stand", "painting", "item_frame",
    "fishing_bobber", "fireball", "small_fireball",
  ]);
  const entityNames = Array.isArray(nearby?.entities)
    ? Array.from(new Set(nearby.entities
        .map((e) => e?.type || e?.name)
        .filter(Boolean)
        .filter((t) => !ENTITY_NOISE.has(String(t).toLowerCase()))))
    : [];

  // Player health: read from first player entity in nearby response.
  // Mineflayer bot.players[name].health is the canonical source;
  // the bot server's /nearby now populates health for player entities.
  let playerHealth = 20;
  if (Array.isArray(nearby?.entities)) {
    const firstPlayer = nearby.entities.find(
      (e) => e?.kind === 'player' && typeof e?.health === 'number'
    );
    if (firstPlayer) playerHealth = firstPlayer.health;
  }

  // Per `raw/gemma-andy/ollama-usage.md` (the post-training reference),
  // the actual production world_state has 17 fields. Missing fields cause
  // the model to fall back to priors. Including them — even with sane
  // defaults — keeps the input on-distribution.
  //
  // AUDIT 2026-05-16: re-added player_health (now available from bot server),
  // target_positions (always empty in v1), and remembered_places (requires
  // GET /marks endpoint on bot server).
  const weather = status?.isRaining ? "rain" : "clear";

  // Fetch remembered places if bot server supports GET /marks.
  let rememberedPlaces = {};
  try {
    const marksResp = await botGet("/marks", botUrl);
    if (marksResp?.marks && typeof marksResp.marks === 'object') {
      rememberedPlaces = marksResp.marks;
    }
  } catch {
    // /marks endpoint not available — use empty (on-distribution default).
  }

  // mBit is optional contextual perception. If the bot/server.js /blocks
  // endpoint is unavailable or temporarily fails, keep canonical world_state
  // intact and expose the failure as metadata instead of aborting the intent.
  let mbitContext = null;
  try {
    mbitContext = await fetchMbitContext(botPos, intent, botUrl);
  } catch (err) {
    mbitContext = {
      ok: false,
      error: err?.message || String(err),
      interpretation_hint: "mBit contextual voxel perception was requested but unavailable; fall back to nearby_blocks/entities and scan tools.",
    };
  }

  const ws = {
    biome: status?.biome ?? "unknown",
    bot_health: status?.health ?? 20,
    bot_position: botPos,
    dimension: status?.dimension ?? "overworld",
    hazards: Array.isArray(nearby?.hazards) ? nearby.hazards : [],
    hunger: status?.food ?? 20,
    inventory: invDict,
    light_level: typeof status?.light_level === "number" ? status.light_level : (status?.isDay ? 15 : 4),
    mbit_context: mbitContext,
    nearby_blocks: blockNames,
    nearby_entities: entityNames,
    player_health: playerHealth,
    player_position: playerPos,
    remembered_places: rememberedPlaces,
    target_positions: {},
    time_of_day: mapTimeOfDay(status?.time),
    weather,
    zone_owner: "shared",
    ...extra, // caller can override server_type, zone_owner, world_text_artifacts, etc.
  };

  return ws;
}
