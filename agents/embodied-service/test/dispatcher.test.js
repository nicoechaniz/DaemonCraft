import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { dispatch, SIGNAL_TOOLS, HANDLERS, foldBotResponse, detectSoftFailure, classifyBotError } from "../lib/dispatcher.js";
import { _reset } from "../lib/schema.js";

describe("dispatcher", () => {
  it("recognizes signal tools as ok=true without HTTP", async () => {
    _reset();
    const r = await dispatch({
      name: "ask_clarification",
      arguments: { question: "What should I build?" },
    });
    assert.ok(r.ok);
    assert.ok(r.signal);
    assert.equal(r.tool, "ask_clarification");
    assert.deepEqual(r.data, { question: "What should I build?" });
  });

  it("returns tool_not_implemented when schema marks unsupported", async () => {
    _reset();
    const r = await dispatch({ name: "plant_crop", arguments: {} });
    assert.equal(r.ok, false);
    assert.equal(r.error_type, "tool_not_implemented");
  });

  it("returns tool_not_canonical for hallucinated names", async () => {
    _reset();
    const r = await dispatch({ name: "definitely_not_a_real_tool", arguments: {} });
    assert.equal(r.ok, false);
    assert.equal(r.error_type, "tool_not_canonical");
  });

  it("HANDLERS table covers every supported non-signal tool in the schema", async () => {
    _reset();
    const { loadSchema } = await import("../lib/schema.js");
    const s = loadSchema();
    const supportedNonSignal = [...s._supported].filter((n) => !SIGNAL_TOOLS.has(n));
    const missing = supportedNonSignal.filter((n) => !(n in HANDLERS));
    assert.deepEqual(
      missing,
      [],
      `dispatcher.js missing handlers for: ${missing.join(", ")}`,
    );
  });

  describe("soft-failure detection", () => {
    it("flags partial mine yields (Mined K/N where K<N)", () => {
      const out = foldBotResponse({
        ok: true, status: 200,
        body: { ok: true, result: "Mined 0/1 oak_log. Have 0 oak_log in inventory." },
      });
      assert.equal(out.ok, false);
      assert.equal(out.error_type, "bot_soft_failure");
      assert.match(out.details, /0\/1/);
    });

    it("passes through full mine yields (Mined K/N where K==N)", () => {
      const out = foldBotResponse({
        ok: true, status: 200,
        body: { ok: true, result: "Mined 2/2 oak_log. Have 2 oak_log in inventory." },
      });
      assert.equal(out.ok, true);
      assert.equal(out.data.result, "Mined 2/2 oak_log. Have 2 oak_log in inventory.");
    });

    it("flags 'Can't ...' soft failures", () => {
      const out = foldBotResponse({
        ok: true, status: 200,
        body: { ok: true, result: "Can't see any quartz_ore from 28, 76, 53. Turn around or move closer." },
      });
      assert.equal(out.ok, false);
      assert.equal(out.error_type, "bot_soft_failure");
    });

    it("flags 'Failed to ...' soft failures", () => {
      const out = foldBotResponse({
        ok: true, status: 200,
        body: { ok: true, result: "Failed to craft oak_planks x4: missing ingredient." },
      });
      assert.equal(out.ok, false);
      assert.equal(out.error_type, "bot_soft_failure");
    });

    it("does NOT flag 'No items to pick up' (legitimate empty outcome)", () => {
      const out = foldBotResponse({
        ok: true, status: 200,
        body: { ok: true, result: "No items to pick up." },
      });
      assert.equal(out.ok, true);
    });

    it("does NOT flag healthy responses with no result string", () => {
      const out = foldBotResponse({
        ok: true, status: 200,
        body: { ok: true, data: { items: [] } },
      });
      assert.equal(out.ok, true);
    });
  });
});

// ── Layer 4: Executor semantic tests ───────────────────────────────────────
// Q1 fix from Mariano's methodology: execution_results[].ok must reflect
// actual embodied success in the world, not merely tool emission or HTTP 200.
//
// These tests verify the mapping from bot responses to ok semantics.
// Supported-tool dispatch paths (which hit the live bot via HTTP) are
// covered indirectly through foldBotResponse; signal/unsupported paths
// are covered directly through dispatch().

describe("executor semantic tests (Layer 4: ok reflects embodied success, not tool emission)", () => {
  it("signal tool dispatch → ok=true (handled upstream, no embodied execution)", async () => {
    _reset();
    const r = await dispatch({ name: "raise_guardian_event", arguments: { category: "test" } });
    assert.equal(r.ok, true);
    assert.equal(r.signal, true);
    assert.equal(r.tool, "raise_guardian_event");
  });

  it("unsupported tool dispatch → ok=false (tool_not_implemented)", async () => {
    _reset();
    const r = await dispatch({ name: "plant_crop", arguments: { crop: "wheat" } });
    assert.equal(r.ok, false);
    assert.equal(r.error_type, "tool_not_implemented");
    assert.equal(r.tool, "plant_crop");
  });

  it("hallucinated tool dispatch → ok=false (tool_not_canonical)", async () => {
    _reset();
    const r = await dispatch({ name: "do_magic", arguments: {} });
    assert.equal(r.ok, false);
    assert.equal(r.error_type, "tool_not_canonical");
    assert.equal(r.tool, "do_magic");
  });

  it("bot soft failure (partial yield) → ok=false even with HTTP 200", () => {
    const out = foldBotResponse({
      ok: true, status: 200,
      body: { ok: true, result: "Mined 1/3 oak_log. Have 1 oak_log in inventory." },
    });
    assert.equal(out.ok, false);
    assert.equal(out.error_type, "bot_soft_failure");
    assert.match(out.details, /1\/3/);
  });

  it("bot full success (complete yield) → ok=true with HTTP 200", () => {
    const out = foldBotResponse({
      ok: true, status: 200,
      body: { ok: true, result: "Mined 5/5 oak_log. Have 5 oak_log in inventory." },
    });
    assert.equal(out.ok, true);
    assert.equal(out.data.result, "Mined 5/5 oak_log. Have 5 oak_log in inventory.");
  });

  it("bot hard failure (HTTP 500) → ok=false with bot_action_failed", () => {
    const out = foldBotResponse({
      ok: false, status: 500,
      body: { error: "Bot movement pathfinder timeout" },
    });
    assert.equal(out.ok, false);
    assert.equal(out.error_type, "bot_action_failed");
    assert.match(out.details, /timeout/);
  });

  it("detectSoftFailure returns null for genuine success strings", () => {
    assert.equal(detectSoftFailure({ result: "Crafted 4 oak_planks." }), null);
    assert.equal(detectSoftFailure({ result: "Placed oak_planks at 10, 64, -5." }), null);
    assert.equal(detectSoftFailure({ result: "No items to pick up." }), null);
  });

  it("detectSoftFailure catches 'Refusing to ...' prefix", () => {
    const msg = "Refusing to place tnt: no_tnt constraint active.";
    const out = detectSoftFailure({ result: msg });
    assert.ok(out);
    assert.match(out, /Refusing to/);
  });
});

// ── Spatial error classifier ───────────────────────────────────────────────
// Promotes a bot's free-text error to one of three canonical error_types
// the runner's Tier 2a auto-recovery is keyed on
// (local_agent/embodied.py:SPATIAL_ERRORS and
// hermes-agent/tools/embodied_plan_tool.py retry block).
describe("classifyBotError", () => {
  it("classifies 'target space is occupied by ...' as target_occupied", () => {
    const msg = "Can't place crafting_table at 0, 70, 1: target space is occupied by prismarine. Dig that block first or choose an empty adjacent space.";
    assert.equal(classifyBotError(msg), "target_occupied");
  });

  it("classifies 'inside my own body' as bot_in_target", () => {
    const msg = "Can't place cobblestone at (5,71,3): that cell is inside my own body and no adjacent empty cell has a solid neighbour to place against. Move me to a clearer spot first.";
    assert.equal(classifyBotError(msg), "bot_in_target");
  });

  it("classifies 'no solid adjacent block' as no_solid_neighbor", () => {
    const msg = "Can't place cobblestone at 0, 100, 0: no solid adjacent block to place against. Choose an empty space next to/above an existing block, or place a support block first.";
    assert.equal(classifyBotError(msg), "no_solid_neighbor");
  });

  it("returns null for unrelated error strings", () => {
    assert.equal(classifyBotError("Bot movement pathfinder timeout"), null);
    assert.equal(classifyBotError("Mined 0/1 oak_log. Have 0 oak_log in inventory."), null);
    assert.equal(classifyBotError("Can't see any quartz_ore from 28, 76, 53."), null);
  });

  it("returns null for empty / non-string input", () => {
    assert.equal(classifyBotError(""), null);
    assert.equal(classifyBotError(null), null);
    assert.equal(classifyBotError(undefined), null);
    assert.equal(classifyBotError(42), null);
  });
});

// ── foldBotResponse: classifier integration ────────────────────────────────
// When a known spatial pattern matches, the canonical error_type is
// emitted INSTEAD of the generic bot_action_failed / bot_soft_failure,
// while preserving the original details string verbatim.
describe("foldBotResponse with spatial classifier", () => {
  it("HTTP 500 + 'target space is occupied' → error_type=target_occupied", () => {
    const out = foldBotResponse({
      ok: false, status: 500,
      body: { error: "Can't place crafting_table at 0, 70, 1: target space is occupied by prismarine. Dig that block first or choose an empty adjacent space." },
    });
    assert.equal(out.ok, false);
    assert.equal(out.error_type, "target_occupied");
    assert.match(out.details, /target space is occupied/);
  });

  it("HTTP 500 + 'inside my own body' → error_type=bot_in_target", () => {
    const out = foldBotResponse({
      ok: false, status: 500,
      body: { error: "Can't place cobblestone at (0,71,0): that cell is inside my own body." },
    });
    assert.equal(out.error_type, "bot_in_target");
  });

  it("HTTP 500 + 'no solid adjacent block' → error_type=no_solid_neighbor", () => {
    const out = foldBotResponse({
      ok: false, status: 500,
      body: { error: "Can't place cobblestone at 0, 100, 0: no solid adjacent block to place against." },
    });
    assert.equal(out.error_type, "no_solid_neighbor");
  });

  it("HTTP 500 generic error → unchanged error_type=bot_action_failed", () => {
    const out = foldBotResponse({
      ok: false, status: 500,
      body: { error: "Bot movement pathfinder timeout" },
    });
    assert.equal(out.error_type, "bot_action_failed");
  });
});
