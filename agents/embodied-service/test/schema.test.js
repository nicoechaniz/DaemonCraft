import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadSchema, isSupported, isCanonical, filterSupported, getToolDef, _reset } from "../lib/schema.js";

describe("schema", () => {
  it("loads the placeholder and exposes 68 canonical tools", () => {
    _reset();
    const s = loadSchema();
    assert.equal(s.allowed_tools.length, 68);
    assert.equal(s._all.size, 68);
  });

  it("flags 43 tools as executor_supported per the team docs", () => {
    _reset();
    const s = loadSchema();
    assert.equal(s._supported.size, 43);
  });

  it("recognizes canonical names", () => {
    _reset();
    assert.ok(isCanonical("scan_nearby"));
    assert.ok(isCanonical("plant_crop"));
    assert.ok(!isCanonical("scan_around")); // hallucinated
  });

  it("isSupported true for executor-implemented, false for pending", () => {
    _reset();
    assert.ok(isSupported("scan_nearby"));   // perception, true
    assert.ok(!isSupported("plant_crop"));   // farming, todo
    assert.ok(!isSupported("look_at"));      // perception, todo
  });

  it("filterSupported intersects with executor_supported set", () => {
    _reset();
    const out = filterSupported(["scan_nearby", "plant_crop", "goto", "fake_tool"]);
    assert.deepEqual(out, ["goto", "scan_nearby"]);
  });

  it("filterSupported with null returns the full supported set", () => {
    _reset();
    const out = filterSupported(null);
    assert.equal(out.length, 43);
    assert.ok(out.includes("scan_nearby"));
    assert.ok(!out.includes("plant_crop"));
  });

  it("getToolDef returns the tool entry or null", () => {
    _reset();
    const def = getToolDef("scan_nearby");
    assert.ok(def);
    assert.equal(def.category, "perception");
    assert.equal(def.executor_supported, true);
    assert.equal(getToolDef("does_not_exist"), null);
  });

  it("blocked_tools list is exposed for audit", () => {
    _reset();
    const s = loadSchema();
    assert.ok(Array.isArray(s.blocked_tools));
    assert.ok(s.blocked_tools.includes("execute_code"));
    assert.ok(s.blocked_tools.includes("attack_player"));
  });
});
