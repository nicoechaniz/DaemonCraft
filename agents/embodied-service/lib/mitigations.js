/**
 * Consumer-side mitigations for known Gemma-Andy regressions.
 *
 * gemma-andy:e4b-v2-2-3-q8_0 (production candidate as of 2026-05-08) has
 * two reproducible behavioral regressions vs the integration guide:
 *
 *   1. **recovery**: when `previous_error` is set, the model may retry
 *      the same failed tool naively, ignoring the documented expectation
 *      to scan/clear obstacle/replan. (3/3 stochastic samples, see
 *      test/reference_cases.test.js.)
 *
 *   2. **out_of_scope**: when given a non-physical request (e.g. "tell
 *      me a joke"), the model may emit empty `tool_calls` (silent — the
 *      upstream agent receives no signal) instead of the documented
 *      `raise_guardian_event(category="out_of_scope")`.
 *
 * Until Mariano retrains, the embodied service detects each pattern,
 * logs LOUD via the per-call mitigations log, and synthesizes a sane
 * fallback so the system stays useful. Mitigations are surfaced in the
 * `/intent` response under `mitigations` so callers (Hermes) can
 * distinguish a real model plan from a synthesized fallback.
 *
 * When the model is fixed, the detector still runs but never fires —
 * zero behavioral cost.
 */

/**
 * @typedef {Object} Mitigation
 * @property {string} regression       - identifier of the known regression
 * @property {string} pattern_detected - what we observed in the model output
 * @property {string} action_taken     - what we did about it
 * @property {Object[]} synthesized_tool_calls - fallback tool_calls injected, if any
 */

/**
 * Detect & mitigate.
 *
 * @param {Object} input  the original /intent body
 * @param {Object} parsed { think, plan } from parser.js
 * @returns {{plan: Object, mitigations: Mitigation[]}}
 */
export function applyMitigations(input, parsed) {
  const mitigations = [];
  const plan = { ...parsed.plan, tool_calls: [...parsed.plan.tool_calls] };

  // ── Mitigation 1: recovery regression ───────────────────────────
  // Trigger: previous_error is set AND the model's plan does not
  // include any obstacle-clearing / scanning / clarification tool
  // before re-emitting the tool that failed.
  if (input?.previous_error?.tool) {
    const failedTool = input.previous_error.tool;
    const tools = plan.tool_calls.map((t) => t.name);
    const recoveryActions = ["scan_nearby", "mine_block", "mine_blocks", "ask_clarification", "raise_guardian_event", "report_execution_error", "move_away", "flee_from"];
    const hasRecovery = tools.some((n) => recoveryActions.includes(n));
    const onlyRetriesFailed = tools.length > 0 && tools.every((n) => n === failedTool);

    if (onlyRetriesFailed && !hasRecovery) {
      // Model is naively retrying. Synthesize a report_execution_error
      // so upstream sees the regression signal instead of an infinite loop.
      const synthesized = {
        name: "report_execution_error",
        arguments: {
          error_type: "model_recovery_regression",
          details: `Gemma-Andy retried failed tool '${failedTool}' without scan/replan. Original previous_error: ${JSON.stringify(input.previous_error)}. Consumer-side mitigation injected this signal. See lib/mitigations.js.`,
          recoverable: false,
        },
      };
      mitigations.push({
        regression: "recovery_naive_retry",
        pattern_detected: `previous_error set on '${failedTool}'; plan only retries '${failedTool}' with no scan/replan`,
        action_taken: "prepended report_execution_error to tool_calls; original retries kept after",
        synthesized_tool_calls: [synthesized],
      });
      plan.tool_calls = [synthesized, ...plan.tool_calls];
    }
  }

  // ── Mitigation 2: out_of_scope silent failure ──────────────────
  // Trigger: model emits empty tool_calls. The integration guide
  // requires at least one signal. Empty is always a regression.
  if (plan.tool_calls.length === 0) {
    const cmd = input?.intent ?? input?.high_level_command ?? "";
    const synthesized = {
      name: "raise_guardian_event",
      arguments: {
        category: "out_of_scope",
        reason: "model emitted empty tool_calls; consumer-side mitigation classifies as out_of_scope",
        command_excerpt: cmd.slice(0, 200),
      },
    };
    mitigations.push({
      regression: "empty_tool_calls",
      pattern_detected: "model returned tool_calls: []",
      action_taken: "synthesized raise_guardian_event(out_of_scope) so upstream receives a signal instead of silent failure",
      synthesized_tool_calls: [synthesized],
    });
    plan.tool_calls = [synthesized];
  }

  return { plan, mitigations };
}
