import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { dispatch, SIGNAL_TOOLS, HANDLERS, foldBotResponse, detectSoftFailure } from "../lib/dispatcher.js";
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
