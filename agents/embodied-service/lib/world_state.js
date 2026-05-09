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
const BOT_API_URL = process.env.BOT_API_URL || "http://localhost:3001";

async function botGet(path) {
  const res = await fetch(`${BOT_API_URL}${path}`);
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
export async function composeWorldState({ extra = {} } = {}) {
  // Issue all reads in parallel; fail fast if any is unavailable.
  const [status, nearby, inventory] = await Promise.all([
    botGet("/status"),
    botGet("/nearby"),
    botGet("/inventory"),
  ]);

  // status: { position: {x,y,z}, time, health, food, ... }
  // nearby: { blocks: [...], entities: [...], hazards: [...], player_position: {x,y,z} }
  // inventory: { items: {oak_log: 5, ...} } OR list of item entries

  const botPos = status?.position
    ? [status.position.x, status.position.y, status.position.z]
    : [0, 64, 0];
  const playerPos = nearby?.player_position
    ? [nearby.player_position.x, nearby.player_position.y, nearby.player_position.z]
    : null;

  // inventory may be {items: {name: count}} OR array of {name, count}
  let invDict = {};
  if (inventory?.items && typeof inventory.items === "object" && !Array.isArray(inventory.items)) {
    invDict = inventory.items;
  } else if (Array.isArray(inventory?.items)) {
    for (const it of inventory.items) {
      if (it?.name) invDict[it.name] = (invDict[it.name] ?? 0) + (it.count ?? 1);
    }
  } else if (inventory && typeof inventory === "object") {
    invDict = inventory;
  }

  const ws = {
    time_of_day: mapTimeOfDay(status?.time),
    bot_position: botPos,
    player_position: playerPos,
    nearby_blocks: Array.isArray(nearby?.blocks) ? nearby.blocks : [],
    nearby_entities: Array.isArray(nearby?.entities) ? nearby.entities : [],
    hazards: Array.isArray(nearby?.hazards) ? nearby.hazards : [],
    inventory: invDict,
    ...extra, // server_type, zone_owner, world_text_artifacts can come from caller
  };

  return ws;
}
