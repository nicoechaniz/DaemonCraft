#!/usr/bin/env node
/**
 * typed_result.js — Type-safe wrapper for mc_* tool results.
 *
 * Every mc_* tool result that flows from the bot server to the LLM (via
 * the gateway) has the same top-level shape, regardless of which tool
 * produced it. Consumers (NarrateGateTracker, StuckPivotTracker,
 * mc_navigate, the LLM itself) read fields directly — no substring
 * matching, no heuristics.
 *
 * Schema:
 *   {
 *     ok: bool,                // did the action complete without exception
 *     outcome: enum,           // what happened (canonical)
 *     category: enum,          // which kind of action (canonical)
 *     target: {x,y,z}|null,    // where the action was aimed (if any)
 *     position_before: {x,y,z},// where the bot was before
 *     position_after: {x,y,z}, // where the bot is after
 *     block: string|null,      // the block involved (place/dig/door/etc)
 *     details: string|null,    // human-readable debug string
 *     // Plus whatever the original tool result returned (mc_move: status, mc_build: coords, etc.)
 *     ...rest
 *   }
 *
 * Outcome enum:
 *   success      — action completed and bot moved/block placed/etc
 *   no_progress  — action ran but bot did not move (pathfinder failed)
 *   cancelled    — action was cancelled (interrupt or preemption)
 *   preempted    — action was stopped because a higher-priority action took over
 *   stuck        — action timed out without progress
 *   error        — action threw or returned an error
 *   displaced    — action ran but bot was knocked off course (fell, pushed)
 *   unknown      — could not classify
 *
 * Category enum:
 *   movement     — goto, goto_near, follow, flee, etc.
 *   build        — place, fill, interact (with block)
 *   mine         — dig, mine, collect
 *   interact     — chat, inventory, equip, use, etc.
 *   craft        — craft, smelt
 *   other        — anything else
 *
 * Mapping from action name to category (deterministic, no string matching
 * at consumer side):
 *   goto, gotonear, goto_near, follow, flee, stop, pathfind, come, navigate → movement
 *   place, fill, build, interact                                            → build
 *   dig, mine, collect, tunnel, spiral                                     → mine
 *   chat, equip, use, eat, drink, sleep, attack, shoot                    → interact
 *   craft, smelt, brew                                                     → craft
 *
 * This module exports:
 *   - CATEGORY_FOR_ACTION: Map<action_name, category>
 *   - isActionJudgeable(name): bool
 *   - wrapToolResult(ok, outcome, category, intent, judge, toolResult): typed result
 *   - REQUIRED_OUTCOMES: Set of valid outcome strings
 *   - REQUIRED_CATEGORIES: Set of valid category strings
 */

// ──────────────────────────────────────────────────────────────────────
// Canonical category mapping (deterministic, no string matching downstream)
// ──────────────────────────────────────────────────────────────────────

const _MOVEMENT_ACTIONS = new Set([
  'goto', 'gotonear', 'goto_near', 'follow', 'flee', 'stop',
  'pathfind', 'come', 'navigate', 'bg_goto',
]);

const _BUILD_ACTIONS = new Set([
  'place', 'fill', 'build', 'interact', 'place_fill',
]);

const _MINE_ACTIONS = new Set([
  'dig', 'mine', 'collect', 'tunnel', 'spiral', 'staircase',
]);

const _CRAFT_ACTIONS = new Set([
  'craft', 'smelt', 'brew', 'furnace_smelt', 'view_craftable',
]);

const _INTERACT_ACTIONS = new Set([
  'chat', 'equip', 'use', 'eat', 'drink', 'sleep', 'attack', 'shoot',
  'sneak', 'shield', 'toss', 'pickup', 'equip_item',
]);

// Map every known action name to its canonical category.
// Consumers do CATEGORY_FOR_ACTION.get(actionName) — no regex, no heuristics.
const CATEGORY_FOR_ACTION = new Map();
for (const a of _MOVEMENT_ACTIONS) CATEGORY_FOR_ACTION.set(a, 'movement');
for (const a of _BUILD_ACTIONS) CATEGORY_FOR_ACTION.set(a, 'build');
for (const a of _MINE_ACTIONS) CATEGORY_FOR_ACTION.set(a, 'mine');
for (const a of _CRAFT_ACTIONS) CATEGORY_FOR_ACTION.set(a, 'craft');
for (const a of _INTERACT_ACTIONS) CATEGORY_FOR_ACTION.set(a, 'interact');

/** Get category for an action name, defaulting to 'other' for unknown. */
export function categoryForAction(actionName) {
  if (!actionName) return 'other';
  return CATEGORY_FOR_ACTION.get(actionName) || 'other';
}

// ──────────────────────────────────────────────────────────────────────
// Canonical outcome enum
// ──────────────────────────────────────────────────────────────────────

export const REQUIRED_OUTCOMES = new Set([
  'success', 'no_progress', 'cancelled', 'preempted',
  'stuck', 'error', 'displaced', 'unknown',
]);

export const REQUIRED_CATEGORIES = new Set([
  'movement', 'build', 'mine', 'interact', 'craft', 'other',
]);

// Actions that produce a judgeAction() verdict (the others don't get a
// position-delta measurement). The set is defined in server.js too;
// this is the canonical list that the typed wrapper trusts.
const _JUDGEABLE_ACTIONS = new Set([
  'goto', 'gotoNear', 'goto_near', 'dig', 'place', 'fill', 'attack', 'collect', 'follow',
]);

export function isActionJudgeable(name) {
  return _JUDGEABLE_ACTIONS.has(name);
}

// ──────────────────────────────────────────────────────────────────────
// The wrap function: take a raw tool result + the judge entry, return
// a typed object with the canonical fields at the top level.
// ──────────────────────────────────────────────────────────────────────

/**
 * Build a typed result from a tool execution.
 *
 * @param {object} args
 * @param {string} args.action     - the action name (e.g. 'goto', 'place')
 * @param {string} args.category   - the action category ('movement', 'build', etc.)
 * @param {object|null} args.target - {x, y, z} of the action target
 * @param {object} args.judge      - the judgeAction() entry (or null if not judgeable)
 * @param {object} args.toolResult - the raw tool result from actionFn()
 * @returns {object} typed result with canonical fields at top level
 */
export function wrapToolResult({ action, target, judge, toolResult, category }) {
  const ok = !judge || judge.outcome !== 'error';
  const outcome = (judge && judge.outcome) || 'unknown';
  const cat = category || categoryForAction(action);
  const pos = (judge && judge.position_before && judge.position_after) ? {
    position_before: judge.position_before,
    position_after: judge.position_after,
  } : {};
  const block = (judge && judge.intent) || null;

  return {
    ok,
    outcome,
    category: cat,
    target: target || null,
    ...pos,
    block,
    details: (judge && judge.reason_code) || null,
    // Preserve the original tool result fields underneath
    ...(toolResult || {}),
  };
}

/**
 * Validate that an object is a properly-formed typed result.
 * Returns null if valid, or a string error message describing the violation.
 */
export function validateTypedResult(obj) {
  if (!obj || typeof obj !== 'object') return 'not an object';
  if (typeof obj.ok !== 'boolean') return 'missing ok (boolean)';
  if (!REQUIRED_OUTCOMES.has(obj.outcome)) {
    return `invalid outcome: "${obj.outcome}" (must be one of ${[...REQUIRED_OUTCOMES].join(', ')})`;
  }
  if (!REQUIRED_CATEGORIES.has(obj.category)) {
    return `invalid category: "${obj.category}" (must be one of ${[...REQUIRED_CATEGORIES].join(', ')})`;
  }
  if (obj.target !== null && (typeof obj.target !== 'object' || obj.target.x == null)) {
    return 'target must be null or {x, y, z}';
  }
  return null;
}
