import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseGemmaAndyResponse, stripThink } from "../lib/parser.js";

const VALID_JSON = JSON.stringify({
  body_plan: ["scan", "mine"],
  checks: ["time=day"],
  tool_calls: [
    { name: "scan_nearby", arguments: { radius: 16 } },
    { name: "mine_block", arguments: { block: "oak_log", quantity: 3 } },
  ],
  failure_policy: "ask the player",
  operational_risk: "low",
});

describe("stripThink", () => {
  it("returns rest unchanged when no <think>", () => {
    const { think, rest } = stripThink("{}");
    assert.equal(think, null);
    assert.equal(rest, "{}");
  });

  it("strips a <think>...</think> block and trims", () => {
    const { think, rest } = stripThink("<think>I should scan first</think>\n{\"a\":1}");
    assert.equal(think, "I should scan first");
    assert.equal(rest, '{"a":1}');
  });
});

describe("parseGemmaAndyResponse", () => {
  it("parses clean JSON", () => {
    const { think, plan } = parseGemmaAndyResponse(VALID_JSON);
    assert.equal(think, null);
    assert.equal(plan.operational_risk, "low");
    assert.equal(plan.tool_calls.length, 2);
  });

  it("parses JSON with <think> prefix", () => {
    const raw = "<think>reasoning here</think>\n" + VALID_JSON;
    const { think, plan } = parseGemmaAndyResponse(raw);
    assert.equal(think, "reasoning here");
    assert.equal(plan.tool_calls.length, 2);
  });

  it("parses JSON with prose around (bracket fallback)", () => {
    const raw = "Sure, here's the plan: " + VALID_JSON + " hope that helps!";
    const { plan } = parseGemmaAndyResponse(raw);
    assert.equal(plan.operational_risk, "low");
  });

  it("rejects empty input", () => {
    assert.throws(() => parseGemmaAndyResponse(""));
    assert.throws(() => parseGemmaAndyResponse("   "));
  });

  it("rejects missing required fields", () => {
    const incomplete = JSON.stringify({ body_plan: [], checks: [], tool_calls: [] });
    assert.throws(() => parseGemmaAndyResponse(incomplete), /missing required/i);
  });

  it("rejects invalid operational_risk value", () => {
    const bad = { ...JSON.parse(VALID_JSON), operational_risk: "extreme" };
    assert.throws(() => parseGemmaAndyResponse(JSON.stringify(bad)), /operational_risk/);
  });

  it("rejects non-array body_plan", () => {
    const bad = { ...JSON.parse(VALID_JSON), body_plan: "scan" };
    assert.throws(() => parseGemmaAndyResponse(JSON.stringify(bad)), /body_plan/);
  });

  it("rejects tool_call without name", () => {
    const bad = JSON.parse(VALID_JSON);
    bad.tool_calls = [{ arguments: {} }];
    assert.throws(() => parseGemmaAndyResponse(JSON.stringify(bad)), /name missing/);
  });

  it("coerces missing arguments to {}", () => {
    const bad = JSON.parse(VALID_JSON);
    bad.tool_calls = [{ name: "stop_movement" }];
    const { plan } = parseGemmaAndyResponse(JSON.stringify(bad));
    assert.deepEqual(plan.tool_calls[0].arguments, {});
  });
});
