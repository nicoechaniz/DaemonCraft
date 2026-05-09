import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { dispatch, SIGNAL_TOOLS, HANDLERS } from "../lib/dispatcher.js";
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
});
