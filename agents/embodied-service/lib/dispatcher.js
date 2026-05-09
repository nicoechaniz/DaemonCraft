/**
 * Tool dispatcher: translates canonical Gemma-Andy v2 tool_calls into
 * bot/server.js HTTP actions.
 *
 * Two layers of translation, both required:
 *
 *   1. **Endpoint shape**. The bot exposes `POST /action/<actionName>`
 *      with a JSON body holding the action's args. There is no generic
 *      `/command` body action endpoint. (Bot's `/command` is a chat
 *      slash-command relay — `/give`, `/tp`, etc.)
 *
 *   2. **Arg shape**. Canonical tools use semantic refs (e.g.
 *      `{target: "oak_log", target_type: "block"}`). The bot's ACTIONS
 *      take coord-pure args (e.g. `{x, y, z}`). We resolve refs via
 *      lib/refs.js (find_blocks / find_entities / marks).
 *
 * Signal tools (ask_clarification, raise_guardian_event,
 * report_execution_error) DO NOT dispatch — they're consumer-side
 * signals returned to Hermes verbatim.
 *
 * When the model emits a tool that's canonical but not executor_supported,
 * we return `error_type: "tool_not_implemented"` so Hermes can replanify
 * via previous_error.
 */
import { isSupported, getToolDef } from "./schema.js";
import { resolveTarget, resolveFrom, asPosition, botPost, botGet, RefResolveError, BOT_API_URL } from "./refs.js";

/**
 * Mapping: canonical Gemma-Andy tool name → handler.
 *
 * Each handler receives the tool_call.arguments object and returns
 * `{ok, data?, error?, error_type?, status?}` matching the shape
 * dispatch() folds together. Most handlers either:
 *   - call botAction(name, args) for a pure rename, or
 *   - resolve refs first, then call botAction.
 */
const HANDLERS = {
  // ── Perception ─────────────────────────────────────────────────
  scan_nearby: async (args) => {
    // Bot's GET /nearby returns full local scan; canonical's
    // optional `blocks`/`entities` filters narrow client-side.
    const radius = args.radius ?? 16;
    const r = await botGet(`/nearby?radius=${radius}`);
    if (!r.ok) return botFail(r);
    let data = r.body?.data ?? r.body;
    if (args.blocks?.length || args.entities?.length) {
      data = { ...data };
      if (args.blocks?.length && Array.isArray(data.blocks)) {
        const want = new Set(args.blocks.map((b) => b.toLowerCase()));
        data.blocks = data.blocks.filter((b) => want.has(b.name.toLowerCase()));
      }
      if (args.entities?.length && Array.isArray(data.entities)) {
        const want = new Set(args.entities.map((e) => e.toLowerCase()));
        data.entities = data.entities.filter((e) => want.has((e.type || e.name || "").toLowerCase()));
      }
    }
    return { ok: true, data };
  },

  take_screenshot: async (args) =>
    botAction("screenshot", { width: 1280, height: 720, file_name: args?.reason }),

  // ── Movement ───────────────────────────────────────────────────
  goto: async (args) => {
    const pos = await resolveTarget(args.target, args.target_type, {
      radius: args.max_distance ?? 32,
    });
    // GoalNear with range=2 if max_distance is small; fallback GoalBlock.
    return botAction("goto_near", { x: pos.x, y: pos.y, z: pos.z, range: 2 });
  },

  follow: async (args) => {
    // Bot follow takes a player username string. EntityRef is usually
    // already a player username from the model's perspective.
    if (typeof args.target !== "string") {
      throw new RefResolveError("bad_target", "follow.target must be a player name string");
    }
    return botAction("follow", { player: args.target });
  },

  stop_movement: async (_args) => botAction("stop", {}),

  move_away: async (args) => {
    const pos = await resolveFrom(args.from ?? args.from_target);
    return botAction("flee", { from: `${pos.x},${pos.y},${pos.z}`, distance: args.distance ?? 8 });
  },

  sneak: async (args) => botAction("sneak", { enable: !!args.enabled }),

  // ── Mining ─────────────────────────────────────────────────────
  mine_block: async (args) => {
    // Canonical: {block, quantity=1, near_player?}. Bot collect handles
    // the find+dig loop; we use that for both single + multi.
    return botAction("collect", { block: args.block, count: args.quantity ?? 1 });
  },

  mine_blocks: async (args) =>
    botAction("collect", { block: args.block, count: args.quantity ?? 1 }),

  collect_drops: async (args) =>
    botAction("pickup", {}),  // Bot's pickup grabs nearby items.

  // ── Building ───────────────────────────────────────────────────
  place_block: async (args) => {
    const pos = await resolvePositionRef(args.position);
    return botAction("place", { block: args.block, x: pos.x, y: pos.y, z: pos.z });
  },

  fill_volume: async (args) => {
    const a = await resolvePositionRef(args.from);
    const b = await resolvePositionRef(args.to);
    return botAction("place_fill", {
      block: args.block, x1: a.x, y1: a.y, z1: a.z, x2: b.x, y2: b.y, z2: b.z, hollow: false,
    });
  },

  // build_blueprint: kept canonical but executor_supported flipped to false
  // in our local schema annotation — bot/server.js's /blueprints serves
  // quest scripts (sensors / phases / scoreboards), not block-placement
  // specs. Real building requires Hermes to issue place_block / fill_volume
  // sequences directly. The schema filter excludes it before each Ollama
  // call, so this handler will never run.
  build_blueprint: async (_args) => ({
    ok: false,
    error_type: "tool_not_implemented",
    details: "build_blueprint blocked at consumer: bot/server.js has no block-placement blueprint executor. Use place_block + fill_volume directly for v1.",
  }),

  ignite: async (args) => {
    const pos = await resolveTarget(args.target, "block");
    return botAction("ignite", { x: pos.x, y: pos.y, z: pos.z });
  },

  // ── Crafting ───────────────────────────────────────────────────
  craft_item: async (args) =>
    botAction("craft", { item: args.item, count: args.quantity ?? 1 }),

  view_craftable: async (args) => {
    // Canonical: {filter: "str optional"}. Bot's recipes(item) takes one
    // item name. We treat the filter as the item to look up. If no filter,
    // return a structured response explaining the bot needs a target.
    const item = (args.filter ?? "").trim();
    if (!item) {
      return {
        ok: false,
        error_type: "missing_filter",
        details: "view_craftable on this executor requires a filter (single item name). Pass `filter: \"<item>\"` to look up its recipes.",
      };
    }
    return botAction("recipes", { item });
  },

  smelt_item: async (args) =>
    botAction("smelt", { input: args.item, fuel: args.fuel ?? "coal", count: args.quantity ?? 1 }),

  check_furnace: async (args) => {
    const pos = await resolvePositionRef(args.furnace_ref);
    return botAction("furnace_check", { x: pos.x, y: pos.y, z: pos.z });
  },

  take_from_furnace: async (args) => {
    const pos = await resolvePositionRef(args.furnace_ref);
    return botAction("furnace_take", { x: pos.x, y: pos.y, z: pos.z });
  },

  // ── Inventory ──────────────────────────────────────────────────
  get_inventory: async (_args) => botGet("/inventory").then(toResult),

  equip_item: async (args) =>
    botAction("equip", { item: args.item, slot: args.slot ?? "hand" }),

  toss_item: async (args) =>
    botAction("toss", { item: args.item, count: args.quantity ?? 1 }),

  pickup_item: async (_args) => botAction("pickup", {}),

  put_in_chest: async (args) => {
    const pos = await resolvePositionRef(args.chest_ref);
    return botAction("deposit", { x: pos.x, y: pos.y, z: pos.z, item: args.item, count: args.quantity ?? 1 });
  },

  take_from_chest: async (args) => {
    const pos = await resolvePositionRef(args.chest_ref);
    return botAction("withdraw", { x: pos.x, y: pos.y, z: pos.z, item: args.item, count: args.quantity ?? 1 });
  },

  view_chest: async (args) => {
    const pos = await resolvePositionRef(args.chest_ref);
    return botAction("list_container", { x: pos.x, y: pos.y, z: pos.z });
  },

  // ── Consumables ────────────────────────────────────────────────
  consume_food: async (_args) => botAction("eat", {}),

  apply_bonemeal: async (args) => {
    const pos = await resolveTarget(args.target, "block");
    return botAction("bonemeal", { x: pos.x, y: pos.y, z: pos.z });
  },

  // ── Combat ─────────────────────────────────────────────────────
  attack_entity: async (args) => {
    // Bot's attack/fight/critical_hit take entity name/type, not coords.
    const target = typeof args.target === "string" ? args.target : null;
    if (!target) throw new RefResolveError("bad_target", "attack_entity.target must be string entity name");
    const style = args.attack_style;
    if (style === "crit") return botAction("critical_hit", { target });
    if (style === "sprint") return botAction("sprint_attack", { target });
    return botAction("attack", { target });
  },

  shoot_bow: async (args) => {
    const target = typeof args.target === "string" ? args.target : null;
    if (!target) throw new RefResolveError("bad_target", "shoot_bow.target must be string entity name");
    return botAction("shoot", { target, predict: true });
  },

  raise_shield: async (args) =>
    botAction("shield_block", { duration: args.duration_seconds ?? 3 }),

  crit_attack: async (args) => {
    const target = typeof args.target === "string" ? args.target : null;
    if (!target) throw new RefResolveError("bad_target", "crit_attack.target must be string entity name");
    return botAction("critical_hit", { target });
  },

  strafe: async (args) => {
    const target = typeof args.around === "string" ? args.around : null;
    if (!target) throw new RefResolveError("bad_target", "strafe.around must be string entity name");
    return botAction("strafe", { target, duration: args.duration_seconds ?? 5 });
  },

  flee_from: async (args) => {
    const pos = await resolveFrom(args.threat ?? args.from_target);
    return botAction("flee", { from: `${pos.x},${pos.y},${pos.z}`, distance: args.distance ?? 12 });
  },

  // ── Farming ────────────────────────────────────────────────────
  till_soil: async (args) => {
    // Bot till takes one tile at a time; we till the bot's current spot.
    const status = await botGet("/status");
    const p = status.body?.data?.position;
    if (!p) return { ok: false, error_type: "world_state_unavailable", details: "couldn't read bot position for till_soil" };
    return botAction("till", { x: Math.floor(p.x), y: Math.floor(p.y) - 1, z: Math.floor(p.z) });
  },

  // ── Fishing ────────────────────────────────────────────────────
  fish: async (_args) => botAction("fish", {}),

  // ── Sleep ──────────────────────────────────────────────────────
  sleep: async (_args) => botAction("sleep_bed", {}),

  // ── Physical memory ────────────────────────────────────────────
  remember_here: async (args) =>
    botAction("mark", { name: args.name, note: args.description ?? "" }),

  forget_place: async (args) => botAction("unmark", { name: args.name }),

  goto_remembered_place: async (args) => botAction("go_mark", { name: args.name }),
};

/** Signal tools — never hit the executor. */
const SIGNAL_TOOLS = new Set([
  "ask_clarification",
  "raise_guardian_event",
  "report_execution_error",
]);

/**
 * Resolve a Position3D ref. Accepts {x,y,z}, [x,y,z], or null/undefined
 * (which is invalid for refs that require a position).
 */
async function resolvePositionRef(ref) {
  const pos = asPosition(ref);
  if (!pos) {
    throw new RefResolveError("missing_target", `position ref required, got ${JSON.stringify(ref)}`);
  }
  return pos;
}

/** POST /action/<name> with the given body, fold the bot's response shape. */
async function botAction(name, body) {
  const r = await botPost(`/action/${name}`, body);
  return foldBotResponse(r);
}

/** Fold the bot's `{ok, status, body}` into `{ok, data?, error?, error_type?, status?}`. */
function foldBotResponse(r) {
  if (r.ok) {
    // Strip `state` key from data — that's bot-side bookkeeping noise
    // for the dispatcher, though the embodied service still surfaces it
    // verbatim if callers want it.
    const { state, ...rest } = r.body ?? {};
    return { ok: true, data: rest };
  }
  return {
    ok: false,
    error_type: "bot_action_failed",
    details: r.body?.error ?? `bot returned status ${r.status}`,
    status: r.status,
  };
}

function botFail(r) {
  return {
    ok: false,
    error_type: "bot_action_failed",
    details: r.body?.error ?? `bot returned status ${r.status}`,
    status: r.status,
  };
}

function toResult(r) { return foldBotResponse(r); }

/**
 * Dispatch one tool_call. Returns `{tool, ok, data?, error?, error_type?}`.
 *
 * Defensive: if the model emits a tool that's canonical but not
 * executor_supported, return `tool_not_implemented` so Hermes can
 * replanify with previous_error.
 */
export async function dispatch(toolCall) {
  const { name, arguments: args = {} } = toolCall ?? {};
  const result = { tool: name };

  if (SIGNAL_TOOLS.has(name)) {
    return { ...result, ok: true, signal: true, data: args };
  }

  if (!isSupported(name)) {
    const def = getToolDef(name);
    return {
      ...result,
      ok: false,
      error_type: def ? "tool_not_implemented" : "tool_not_canonical",
      details: def
        ? `'${name}' is canonical but executor_supported=false in schema`
        : `'${name}' is not in tool_schema_v2.json allowed_tools`,
    };
  }

  const handler = HANDLERS[name];
  if (!handler) {
    return {
      ...result,
      ok: false,
      error_type: "dispatcher_mapping_missing",
      details: `schema marks '${name}' supported but no handler is registered — fix in dispatcher.js`,
    };
  }

  try {
    const out = await handler(args);
    return { ...result, ...out };
  } catch (err) {
    if (err instanceof RefResolveError) {
      return { ...result, ok: false, error_type: err.error_type, details: err.details };
    }
    return {
      ...result,
      ok: false,
      error_type: "dispatcher_exception",
      details: err?.message ?? String(err),
    };
  }
}

export { SIGNAL_TOOLS, HANDLERS, BOT_API_URL };
