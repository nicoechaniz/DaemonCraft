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
import { resolveTarget, resolveFrom, asPosition, resolvePositionKeyword, botPost, botGet, RefResolveError, DEFAULT_BOT_URL } from "./refs.js";

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
    // When specific blocks are requested, use find_blocks (efficient
    // Mineflayer chunk search, no practical radius limit). For entities
    // and general scans, use /nearby (brute-force, capped at 64).
    const radius = args.radius ?? 64;
    const wantBlocks = args.blocks?.length ? new Set(args.blocks.map((b) => b.toLowerCase())) : null;
    const wantEntities = args.entities?.length ? new Set(args.entities.map((e) => e.toLowerCase())) : null;

    let blocks = [];
    let entities = [];

    if (wantBlocks) {
      // Use efficient find_blocks for each requested block type
      const searches = [...wantBlocks].map(async (blockName) => {
        const r = await botPost("/action/find_blocks", { block: blockName, radius, count: 50 });
        if (r.ok && Array.isArray(r.body?.locations)) {
          const locs = r.body.locations;
          // Return EACH location as a block entry with position
          return locs.map(loc => ({
            name: blockName,
            position: { x: Math.floor(loc.x), y: Math.floor(loc.y), z: Math.floor(loc.z) },
          }));
        }
        return [];
      });
      const results = await Promise.all(searches);
      const allFound = results.flat();
      // Preserve individual positions — don't merge
      blocks = allFound.map((b, i) => ({
        name: b.name,
        nearest: b.position,
        count: allFound.filter(bb => bb.name === b.name).length,
      }));
      // Deduplicate by name, keep first nearest
      const seen = new Set();
      blocks = blocks.filter(b => {
        if (seen.has(b.name)) return false;
        seen.add(b.name);
        return true;
      });
    }

    // Entities always come from /nearby
    const nearbyR = await botGet(`/nearby?radius=${Math.min(radius, 64)}`);
    if (nearbyR.ok) {
      const nd = nearbyR.body?.data ?? nearbyR.body ?? {};
      if (Array.isArray(nd.entities)) entities = nd.entities;
      // If no specific blocks requested, use nearby's block scan
      if (!wantBlocks && Array.isArray(nd.blocks)) {
        blocks = nd.blocks;
      }
    }

    // Client-side filter
    if (wantEntities) {
      entities = entities.filter((e) => wantEntities.has((e.type || e.name || "").toLowerCase()));
    }

    return { ok: true, data: { blocks, entities, scanRadius: radius } };
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
    return botAction("place", { block: normalizeItemName(args.block), x: pos.x, y: pos.y, z: pos.z });
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
  craft_item: async (args) => {
    // Field-test 2026-05-09 round 4: model emits craft_item without
    // ensuring proximity to a crafting table. Bot rejects with
    // "recipe appears craftable; try again near a crafting table".
    // If `use_crafting_table` is requested, find the nearest table
    // and goto_near it first. Best-effort — if no table is visible,
    // we let the craft attempt proceed and surface the bot's error.
    const wantsTable = args.use_crafting_table !== false;
    if (wantsTable) {
      try {
        const r = await botPost("/action/find_blocks", { block: "crafting_table", radius: 32, count: 1 });
        const locs = r.body?.locations ?? [];
        if (locs.length) {
          const t = locs[0];
          await botPost("/action/goto_near", { x: t.x, y: t.y, z: t.z, range: 2 });
        }
      } catch { /* fallthrough to craft attempt */ }
    }
    return botAction("craft", { item: normalizeItemName(args.item), count: args.quantity ?? 1 });
  },

  view_craftable: async (args) => {
    // Canonical: {filter: "str optional"}. Bot's recipes(item) takes one
    // item name. We treat the filter as the item to look up. If no filter,
    // return a structured response explaining the bot needs a target.
    const raw = (args.filter ?? "").trim();
    if (!raw) {
      return {
        ok: false,
        error_type: "missing_filter",
        details: "view_craftable on this executor requires a filter (single item name). Pass `filter: \"<item>\"` to look up its recipes.",
      };
    }
    return botAction("recipes", { item: normalizeItemName(raw) });
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
 * Resolve a Position3D ref. Accepts {x,y,z}, [x,y,z], or string
 * keywords like "current"/"here"/"in_front" (model regression observed
 * 2026-05-09 — we resolve via bot's current position rather than fail).
 */
async function resolvePositionRef(ref) {
  const pos = asPosition(ref);
  if (pos) return pos;
  // Try string keyword fallback (model fabrication regression)
  if (typeof ref === "string") {
    const resolved = await resolvePositionKeyword(ref);
    if (resolved) return resolved;
  }
  throw new RefResolveError("missing_target", `position ref required, got ${JSON.stringify(ref)}`);
}

/**
 * Normalize common LLM item-name regressions to the canonical Minecraft
 * names. Catches the "sticks" → "stick" plural-form regression observed
 * in field-test 3 (2026-05-09). Add aliases as new regressions surface.
 */
const ITEM_ALIASES = {
  sticks: "stick",
  torches: "torch",
  planks: "oak_planks",            // ambiguous — defaults to oak; model can specify
  logs: "oak_log",
  apples: "apple",
  arrows: "arrow",
  string: "string",                // already canonical
  cobble: "cobblestone",
  cobblestones: "cobblestone",
  wood: "oak_log",                  // pre-1.13-style
};

function normalizeItemName(name) {
  if (typeof name !== "string") return name;
  const lower = name.trim().toLowerCase();
  return ITEM_ALIASES[lower] ?? lower;
}

/** POST /action/<name> with the given body, fold the bot's response shape. */
async function botAction(name, body, botUrl = null) {
  const r = await botPost(`/action/${name}`, body, botUrl);
  return foldBotResponse(r);
}

/**
 * Canonical spatial-failure classifiers — pattern-match the bot's error
 * string and promote a generic `bot_action_failed` / `bot_soft_failure`
 * to one of the three canonical spatial error_types the runner's Tier 2a
 * auto-recovery is keyed on (`local_agent/embodied.py:SPATIAL_ERRORS`
 * and `hermes-agent/tools/embodied_plan_tool.py` retry block).
 *
 * Kept deliberately small (3 patterns) to avoid drift from the runner's
 * expected set. Anything not matched here falls through to the generic
 * `bot_action_failed` / `bot_soft_failure` and is recovered at the SOUL
 * pattern-matching layer instead.
 */
const SPATIAL_ERROR_CLASSIFIERS = [
  [/target space is occupied/i, "target_occupied"],
  [/inside my own body|own footprint/i, "bot_in_target"],
  [/no solid adjacent block|no solid neighbour to place against/i, "no_solid_neighbor"],
];

function classifyBotError(details) {
  if (!details || typeof details !== "string") return null;
  for (const [pattern, error_type] of SPATIAL_ERROR_CLASSIFIERS) {
    if (pattern.test(details)) return error_type;
  }
  return null;
}

/**
 * Fold the bot's `{ok, status, body}` into `{ok, data?, error?, error_type?, status?}`.
 *
 * The bot returns HTTP 200 with `{ok: true, result: "Mined 0/1 oak_log..."}`
 * for **soft failures** — the action ran without throwing but didn't
 * accomplish the goal (block out of reach, drops despawned, partial
 * yield, etc.). Plain HTTP-code mapping reports these as ok=true,
 * which misleads upstream agents trying to recover. Detected via
 * `result` string patterns and surfaced as `ok=false` with
 * `error_type: "bot_soft_failure"`.
 *
 * Spatial placement failures are further classified into canonical
 * error_types (`target_occupied | bot_in_target | no_solid_neighbor`)
 * via `classifyBotError()` so the runner's Tier 2a auto-recovery (which
 * is keyed on these exact strings) fires deterministically instead of
 * relying on the SOUL pattern-matching fallback.
 */
function foldBotResponse(r) {
  if (r.ok) {
    const { state, ...rest } = r.body ?? {};
    const softFailure = detectSoftFailure(rest);
    if (softFailure) {
      return {
        ok: false,
        error_type: classifyBotError(softFailure) || "bot_soft_failure",
        details: softFailure,
        data: rest,
      };
    }
    return { ok: true, data: rest };
  }
  const details = r.body?.error ?? `bot returned status ${r.status}`;
  return {
    ok: false,
    error_type: classifyBotError(details) || "bot_action_failed",
    details,
    status: r.status,
  };
}

/**
 * Inspect bot's success-shaped response for soft-failure markers.
 * Returns a string description of the soft failure, or null if the
 * action genuinely succeeded.
 *
 * Patterns recognized (all from real bot responses observed in
 * field-test 2026-05-09):
 *   - "Mined 0/N <block>" — collect found blocks but couldn't dig any
 *   - "Mined K/N <block>" with K<N — partial yield
 *   - "No items to pick up" — pickup found no drops (often legitimate
 *     but ambiguous; we leave this as ok=true for now since intent
 *     "collect what's around" is satisfiable by an empty collection)
 *   - "Can't ..." — bot's standard error prefix on inability
 *   - "Failed to ..." — explicit failure prefix
 */
function detectSoftFailure(body) {
  const result = body?.result;
  if (typeof result !== "string") return null;
  // "Mined K/N" partial-yield detector
  const m = result.match(/Mined\s+(\d+)\/(\d+)/i);
  if (m) {
    const yielded = parseInt(m[1], 10);
    const requested = parseInt(m[2], 10);
    if (yielded < requested) {
      return `bot yielded ${yielded}/${requested} (partial mine): ${result.slice(0, 200)}`;
    }
  }
  // Generic failure-prefix detectors (bot returns 200 with these for
  // recoverable in-world rejections)
  if (/^(Can't|Failed to|Refusing to|No mineable block|Unknown block|Unknown item)/i.test(result)) {
    return result.slice(0, 200);
  }
  return null;
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
export async function dispatch(toolCall, botUrl = null, allowedTools = null) {
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

  // Enforce per-turn tool narrowing: reject tools outside the caller's allowed set.
  // Signal tools (ask_clarification, etc.) bypass this — they're always safe.
  if (allowedTools && !allowedTools.includes(name)) {
    return {
      ...result,
      ok: false,
      error_type: "tool_not_allowed",
      details: `'${name}' is not in the allowed_tools set for this turn [${allowedTools.join(", ")}]`,
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

export { SIGNAL_TOOLS, HANDLERS, DEFAULT_BOT_URL, foldBotResponse, detectSoftFailure, classifyBotError };
