import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { canonicalStringify } from "../lib/ollama.js";

describe("canonicalStringify (Rule 2: matches Python json.dumps(sort_keys=True, ensure_ascii=True))", () => {
  it("sorts object keys alphabetically", () => {
    const out = canonicalStringify({ b: 1, a: 2, c: 3 });
    assert.equal(out, '{"a": 2, "b": 1, "c": 3}');
  });

  it("recurses into nested objects, sorting at every level", () => {
    const out = canonicalStringify({ outer: { z: 1, a: 2 }, alpha: 3 });
    assert.equal(out, '{"alpha": 3, "outer": {"a": 2, "z": 1}}');
  });

  it("preserves array order (model trained on ordered tool_calls)", () => {
    const out = canonicalStringify({ tools: ["scan", "mine", "collect"] });
    assert.equal(out, '{"tools": ["scan", "mine", "collect"]}');
  });

  it("escapes non-ASCII as \\uXXXX (ensure_ascii)", () => {
    const out = canonicalStringify({ word: "árbol" });
    // á = U+00E1
    assert.equal(out, '{"word": "\\u00e1rbol"}');
  });

  it("escapes emoji via surrogate pair", () => {
    const out = canonicalStringify({ icon: "🎮" }); // U+1F3AE
    assert.equal(out, '{"icon": "\\ud83c\\udfae"}');
  });

  it("handles booleans, null, finite numbers", () => {
    const out = canonicalStringify({ a: true, b: false, c: null, d: 0, e: -3.14 });
    assert.equal(out, '{"a": true, "b": false, "c": null, "d": 0, "e": -3.14}');
  });

  it("rejects NaN/Infinity (would break Python parity)", () => {
    assert.throws(() => canonicalStringify(Number.NaN));
    assert.throws(() => canonicalStringify(Number.POSITIVE_INFINITY));
  });

  it("matches Python output for a realistic Gemma-Andy payload", () => {
    const payload = {
      world_state: {
        time_of_day: "day",
        bot_position: [10, 64, 5],
        nearby_blocks: ["oak_log", "grass_block"],
        inventory: { oak_planks: 20 },
      },
      high_level_command: "Help.",
      allowed_tools: ["scan_nearby", "goto"],
      previous_error: null,
      guardian_constraints: { autonomy_level: 2, no_tnt: true },
    };
    const out = canonicalStringify(payload);
    // Top-level keys must come out in alphabetical order: allowed_tools,
    // guardian_constraints, high_level_command, previous_error, world_state.
    assert.match(
      out,
      /^\{"allowed_tools": .*"guardian_constraints": .*"high_level_command": .*"previous_error": null, "world_state":/,
    );
  });
});
