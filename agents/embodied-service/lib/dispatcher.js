/**
 * Tool dispatcher: maps canonical Gemma-Andy tool names to bot/server.js
 * HTTP endpoints + arg-shape transformations.
 *
 * Keeps the executor-side mapping decoupled from the schema. When
 * bot/server.js gains a new endpoint, you flip the schema flag
 * (executor_supported: true) AND register the mapping here. Tests that
 * iterate the schema will catch any mismatch.
 *
 * Signal tools (ask_clarification, raise_guardian_event,
 * report_execution_error) DO NOT dispatch to bot/server.js — they're
 * consumer-side signals returned to Hermes verbatim. The dispatcher
 * recognizes them and returns a structured result without making an
 * HTTP call.
 */
import { isSupported, getToolDef } from "./schema.js";

const BOT_API_URL = process.env.BOT_API_URL || "http://localhost:3001";

/**
 * Mapping: canonical tool name → handler function.
 *
 * Each handler receives the tool_call.arguments object and returns
 * `{ok, data?, error?}` matching bot/server.js conventions.
 *
 * Most handlers are thin wrappers around `botPost` / `botGet`.
 */
const HANDLERS = {
  // ── Perception ──────────────────────────────────────────────────────
  scan_nearby: async (args) => botGet(`/nearby?radius=${args.radius ?? 16}`),
  take_screenshot: async (_args) => botPost("/screenshot", {}),

  // ── Movement ────────────────────────────────────────────────────────
  goto: async (args) => {
    return botPost("/command", {
      action: "goto",
      target: args.target,
      target_type: args.target_type ?? "position",
      max_distance: args.max_distance,
      avoid_hazards: args.avoid_hazards ?? true,
    });
  },
  follow: async (args) =>
    botPost("/command", { action: "follow", target: args.target, distance: args.distance }),
  stop_movement: async (_args) => botPost("/command", { action: "stop" }),
  move_away: async (args) =>
    botPost("/command", {
      action: "move_away",
      from_target: args.from_target,
      distance: args.distance ?? 8,
    }),
  sneak: async (args) => botPost("/command", { action: "sneak", on: !!args.on }),

  // ── Mining ──────────────────────────────────────────────────────────
  mine_block: async (args) =>
    botPost("/command", {
      action: "mine_block",
      block: args.block,
      quantity: args.quantity ?? 1,
      max_radius: args.max_radius ?? 16,
      near_player: args.near_player ?? false,
    }),
  mine_blocks: async (args) =>
    botPost("/command", {
      action: "mine_blocks",
      blocks: args.blocks,
      quantity: args.quantity ?? 1,
    }),
  collect_drops: async (args) =>
    botPost("/command", {
      action: "collect_drops",
      items: args.items,
      radius: args.radius ?? 6,
    }),

  // ── Building ────────────────────────────────────────────────────────
  place_block: async (args) =>
    botPost("/command", { action: "place_block", block: args.block, position: args.position, face: args.face }),
  fill_volume: async (args) =>
    botPost("/command", { action: "fill_volume", block: args.block, from: args.from, to: args.to }),
  build_blueprint: async (args) =>
    botPost("/blueprints", { action: "build", blueprint_id: args.blueprint_id, anchor: args.anchor }),
  // ignite is `building` per canonical (place_fire stays blocked separately)
  ignite: async (args) =>
    botPost("/command", { action: "ignite", target: args.target, purpose: args.purpose }),

  // ── Crafting ────────────────────────────────────────────────────────
  craft_item: async (args) =>
    botPost("/command", { action: "craft_item", item: args.item, quantity: args.quantity ?? 1 }),
  view_craftable: async (_args) => botPost("/command", { action: "view_craftable" }),
  smelt_item: async (args) =>
    botPost("/furnaces", { action: "smelt", item: args.item, fuel: args.fuel, quantity: args.quantity ?? 1 }),
  check_furnace: async (args) =>
    botPost("/furnaces", { action: "check", furnace_ref: args.furnace_ref }),
  take_from_furnace: async (args) =>
    botPost("/furnaces", { action: "take", furnace_ref: args.furnace_ref, items: args.items }),

  // ── Inventory ───────────────────────────────────────────────────────
  get_inventory: async (_args) => botGet("/inventory"),
  equip_item: async (args) =>
    botPost("/command", { action: "equip", item: args.item, slot: args.slot ?? "hand" }),
  view_chest: async (args) =>
    botPost("/command", { action: "view_chest", chest_position: args.chest_position }),
  take_from_chest: async (args) =>
    botPost("/command", { action: "take_from_chest", chest_position: args.chest_position, items: args.items }),
  put_in_chest: async (args) =>
    botPost("/command", { action: "put_in_chest", chest_position: args.chest_position, items: args.items }),
  toss_item: async (args) =>
    botPost("/command", { action: "toss", item: args.item, quantity: args.quantity ?? 1, target: args.target }),
  pickup_item: async (args) =>
    botPost("/command", { action: "pickup", item: args.item, radius: args.radius ?? 8 }),

  // ── Combat ──────────────────────────────────────────────────────────
  attack_entity: async (args) =>
    botPost("/command", { action: "attack", target: args.target, weapon: args.weapon }),
  flee_from: async (args) =>
    botPost("/command", { action: "flee_from", from_target: args.from_target, distance: args.distance ?? 16 }),
  raise_shield: async (args) => botPost("/command", { action: "raise_shield", on: !!args.on }),
  crit_attack: async (args) => botPost("/command", { action: "crit_attack", target: args.target }),
  shoot_bow: async (args) => botPost("/command", { action: "shoot_bow", target: args.target }),
  strafe: async (args) =>
    botPost("/command", { action: "strafe", around: args.around, duration_seconds: args.duration_seconds ?? 5 }),

  // ── Consumables ─────────────────────────────────────────────────────
  consume_food: async (args) =>
    botPost("/command", { action: "eat", food: args.food, min_hunger_before: args.min_hunger_before }),
  apply_bonemeal: async (args) =>
    botPost("/command", { action: "bonemeal", target: args.target, quantity: args.quantity ?? 1 }),

  // ── Farming ─────────────────────────────────────────────────────────
  till_soil: async (args) => botPost("/command", { action: "till", position: args.position }),

  // ── Physical memory ────────────────────────────────────────────────
  remember_here: async (args) =>
    botPost("/command", { action: "mark", name: args.name, description: args.description }),
  forget_place: async (args) =>
    botPost("/command", { action: "forget_place", name: args.name }),
  goto_remembered_place: async (args) =>
    botPost("/command", { action: "go_mark", name: args.name }),

  // ── Sleep ───────────────────────────────────────────────────────────
  sleep: async (args) =>
    botPost("/command", { action: "sleep", bed_ref: args.bed_ref, only_if_night: args.only_if_night ?? true }),

  // ── Fishing ─────────────────────────────────────────────────────────
  fish: async (args) =>
    botPost("/command", { action: "fish", duration_seconds: args.duration_seconds ?? 60 }),
};

/** Signal tools — never hit the executor. */
const SIGNAL_TOOLS = new Set([
  "ask_clarification",
  "raise_guardian_event",
  "report_execution_error",
]);

async function botGet(path) {
  const res = await fetch(`${BOT_API_URL}${path}`);
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  return res.ok ? { ok: true, data: data.data ?? data } : { ok: false, error: data, status: res.status };
}

async function botPost(path, body) {
  const res = await fetch(`${BOT_API_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  return res.ok ? { ok: true, data: data.data ?? data } : { ok: false, error: data, status: res.status };
}

/**
 * Dispatch one tool_call. Returns `{tool, ok, data?, error?, error_type?}`.
 *
 * Defensive: if the model emits a tool that's not supported (despite our
 * filter on the consumer side), return `error_type: "tool_not_implemented"`
 * so Hermes can replanify with previous_error.
 */
export async function dispatch(toolCall) {
  const { name, arguments: args = {} } = toolCall ?? {};
  const result = { tool: name };

  if (SIGNAL_TOOLS.has(name)) {
    // Pass through to Hermes; not an executor call.
    result.ok = true;
    result.signal = true;
    result.data = args;
    return result;
  }

  if (!isSupported(name)) {
    const def = getToolDef(name);
    result.ok = false;
    result.error_type = def ? "tool_not_implemented" : "tool_not_canonical";
    result.details = def
      ? `'${name}' is canonical but executor_supported=false in schema`
      : `'${name}' is not in tool_schema_v2.placeholder.json allowed_tools`;
    return result;
  }

  const handler = HANDLERS[name];
  if (!handler) {
    result.ok = false;
    result.error_type = "dispatcher_mapping_missing";
    result.details = `schema marks '${name}' as supported but no handler is registered in dispatcher.js — bug, fix me`;
    return result;
  }

  try {
    const out = await handler(args);
    return { ...result, ...out };
  } catch (err) {
    return {
      ...result,
      ok: false,
      error_type: "dispatcher_exception",
      details: err?.message ?? String(err),
    };
  }
}

export { SIGNAL_TOOLS, HANDLERS, BOT_API_URL };
