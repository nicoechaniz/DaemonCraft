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
export async function composeWorldState({ extra = {}, botUrl = null } = {}) {
  // Issue reads in parallel. /status gives biome, health, hunger, time;
  // /nearby gives blocks + entities (radius 64 to catch players further
  // out); /inventory gives items; /marks gives remembered_places.
  const [status, nearby, inventory, marks] = await Promise.all([
    botGet("/status", botUrl),
    botGet("/nearby?radius=64", botUrl),
    botGet("/inventory", botUrl),
    botGet("/marks", botUrl).catch(() => null),
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

  // Per `raw/gemma-andy/ollama-usage.md` (the post-training reference),
  // the actual production world_state has 17 fields, not just the 7
  // documented in the integration guide table. Missing fields cause the
  // model to fall back to priors. Including them — even with sane
  // defaults — keeps the input on-distribution.
  const weather = status?.isRaining ? "rain" : "clear";
  const remembered_places = (marks && typeof marks === "object") ? marks : {};

  const ws = {
    biome: status?.biome ?? "unknown",
    bot_health: status?.health ?? 20,
    bot_position: botPos,
    dimension: status?.dimension ?? "overworld",
    hazards: Array.isArray(nearby?.hazards) ? nearby.hazards : [],
    hunger: status?.food ?? 20,
    inventory: invDict,
    light_level: typeof status?.light_level === "number" ? status.light_level : (status?.isDay ? 15 : 4),
    nearby_blocks: blockNames,
    nearby_entities: entityNames,
    player_health: 20, // bot can't reliably read remote player health from Mineflayer
    player_position: playerPos,
    remembered_places,
    target_positions: {},
    time_of_day: mapTimeOfDay(status?.time),
    weather,
    zone_owner: "shared",
    ...extra, // caller can override server_type, zone_owner, world_text_artifacts, etc.
  };

  return ws;
}
