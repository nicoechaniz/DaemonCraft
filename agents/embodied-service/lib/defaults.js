/**
 * Default values applied when the intent omits them.
 *
 * Per `raw/gemma-andy/integration-options-decision.md` — the embodied
 * service has its own "safe set" defaults so callers can pass only an
 * intent and get reasonable behavior.
 */
// Guardian constraints — must match the canonical training distribution
// exactly (see Mar-IA-no/deamoncraft-gemma4-andy:examples/eval_with_adapter.py
// EXAMPLE_USER.guardian_constraints). Field-test 2026-05-09 surfaced that
// missing `executor_filtering` / `no_player_harm` and an extra
// `protected_zone_owner` field shifted us off-distribution and the model
// emitted fabricated goto coords.
export const DEFAULT_GUARDIAN_CONSTRAINTS = {
  autonomy_level: 2,
  executor_filtering: true,
  no_player_harm: true,
  no_protected_zone_edit: true,
  no_tnt: true,
};

/**
 * Default `allowed_tools` when the caller passes null. Kept narrow — covers
 * recolección + crafting + chat signals + safe combat + memory. Callers
 * who want broader access should pass an explicit subset.
 *
 * The schema filter in lib/schema.js will further intersect this with
 * the executor_supported set, so even if a caller passes a wider list,
 * only currently-implemented tools reach the model.
 */
export const DEFAULT_ALLOWED_TOOLS = [
  // perception
  "scan_nearby",
  "take_screenshot",
  // movement
  "goto",
  "follow",
  "stop_movement",
  "move_away",
  "sneak",
  // mining
  "mine_block",
  "mine_blocks",
  "collect_drops",
  // building (ignite is here per canonical, not combat)
  "place_block",
  "fill_volume",
  "build_blueprint",
  // crafting
  "craft_item",
  "view_craftable",
  "smelt_item",
  "check_furnace",
  "take_from_furnace",
  // inventory
  "get_inventory",
  "equip_item",
  "view_chest",
  "take_from_chest",
  "put_in_chest",
  "toss_item",
  "pickup_item",
  // combat (defensive only by default — caller opts into ignite/crit_attack/strafe)
  "attack_entity",
  "flee_from",
  "raise_shield",
  // consumables
  "consume_food",
  "apply_bonemeal",
  // farming
  "till_soil",
  // physical_memory
  "remember_here",
  "forget_place",
  "goto_remembered_place",
  // sleep
  "sleep",
  // fishing
  "fish",
  // signals — ALWAYS include the floats per the integration guide
  "ask_clarification",
  "raise_guardian_event",
  "report_execution_error",
];

/** Default deadline for the whole intent (compose + Ollama + dispatch). */
export const DEFAULT_DEADLINE_SECONDS = 30;
