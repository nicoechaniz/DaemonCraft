/**
 * Unit tests for consumer-side mitigations of known Gemma-Andy regressions.
 *
 * These run pure (no network). The model regressions themselves are
 * documented + reproduced in test/reference_cases.test.js.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { applyMitigations } from "../lib/mitigations.js";

const VALID_PLAN = {
  body_plan: ["step 1"],
  checks: ["check 1"],
  tool_calls: [],
  failure_policy: "fail policy",
  operational_risk: "low",
};

describe("applyMitigations", () => {
  test("no-op when plan is healthy and no previous_error", () => {
    const input = { intent: "Mine wood." };
    const parsed = {
      think: null,
      plan: {
        ...VALID_PLAN,
        tool_calls: [{ name: "mine_block", arguments: { block: "oak_log" } }],
      },
    };
    const out = applyMitigations(input, parsed);
    assert.equal(out.mitigations.length, 0);
    assert.deepEqual(out.plan.tool_calls, parsed.plan.tool_calls);
  });

  test("recovery_naive_retry: detects naive retry of failed tool", () => {
    const input = {
      intent: "Go to the player.",
      previous_error: { tool: "goto", error_type: "stuck", details: "leaves blocking" },
    };
    const parsed = {
      think: null,
      plan: {
        ...VALID_PLAN,
        tool_calls: [{ name: "goto", arguments: { target: [30, 64, 12], target_type: "position" } }],
      },
    };
    const out = applyMitigations(input, parsed);
    assert.equal(out.mitigations.length, 1);
    assert.equal(out.mitigations[0].regression, "recovery_naive_retry");
    // Synthesized signal must be first in the dispatch order
    assert.equal(out.plan.tool_calls[0].name, "report_execution_error");
    assert.equal(out.plan.tool_calls[0].arguments.error_type, "model_recovery_regression");
    // Original retry preserved after the signal
    assert.equal(out.plan.tool_calls[1].name, "goto");
  });

  test("recovery: NO mitigation when plan includes scan/clear actions", () => {
    const input = {
      intent: "Go to the player.",
      previous_error: { tool: "goto", error_type: "stuck", details: "leaves" },
    };
    const parsed = {
      think: "leaves blocking, mine them first",
      plan: {
        ...VALID_PLAN,
        tool_calls: [
          { name: "scan_nearby", arguments: { blocks: ["leaves"] } },
          { name: "mine_block", arguments: { block: "leaves", quantity: 3 } },
          { name: "goto", arguments: { target: [30, 64, 12] } },
        ],
      },
    };
    const out = applyMitigations(input, parsed);
    assert.equal(out.mitigations.length, 0,
      `expected no mitigation when plan recovers properly, got: ${JSON.stringify(out.mitigations)}`);
  });

  test("empty_tool_calls: synthesizes raise_guardian_event(out_of_scope)", () => {
    const input = { intent: "Tell me a joke." };
    const parsed = { think: null, plan: { ...VALID_PLAN, tool_calls: [] } };
    const out = applyMitigations(input, parsed);
    assert.equal(out.mitigations.length, 1);
    assert.equal(out.mitigations[0].regression, "empty_tool_calls");
    assert.equal(out.plan.tool_calls.length, 1);
    assert.equal(out.plan.tool_calls[0].name, "raise_guardian_event");
    assert.equal(out.plan.tool_calls[0].arguments.category, "out_of_scope");
    assert.match(out.plan.tool_calls[0].arguments.command_excerpt, /joke/);
  });

  test("empty_tool_calls + previous_error: emits both mitigations", () => {
    // Model returned empty tool_calls AND previous_error was set —
    // empty_tool_calls fires; recovery_naive_retry does not (no retry to detect).
    const input = {
      intent: "Go to the player.",
      previous_error: { tool: "goto", error_type: "stuck" },
    };
    const parsed = { think: null, plan: { ...VALID_PLAN, tool_calls: [] } };
    const out = applyMitigations(input, parsed);
    assert.equal(out.mitigations.length, 1);
    assert.equal(out.mitigations[0].regression, "empty_tool_calls");
  });

  test("preserves think + other plan fields untouched", () => {
    const input = { intent: "Tell me a joke." };
    const parsed = {
      think: "this is reasoning",
      plan: { ...VALID_PLAN, tool_calls: [], operational_risk: "none" },
    };
    const out = applyMitigations(input, parsed);
    assert.equal(out.plan.operational_risk, "none");
    assert.deepEqual(out.plan.body_plan, VALID_PLAN.body_plan);
    assert.deepEqual(out.plan.checks, VALID_PLAN.checks);
    assert.equal(out.plan.failure_policy, VALID_PLAN.failure_policy);
  });
});
