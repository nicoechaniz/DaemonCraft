import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { composeWorldState } from "../lib/world_state.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function jsonResponse(body, ok = true, status = 200) {
  return {
    ok,
    status,
    async json() {
      return body;
    },
  };
}

function installFakeBotFetch(requests, overrides = {}) {
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    requests.push({ pathname: u.pathname, search: u.search, params: Object.fromEntries(u.searchParams.entries()) });

    if (u.pathname === "/status") {
      return jsonResponse({ ok: true, data: {
        position: { x: 10.6, y: 64.1, z: 5.5 },
        biome: "plains",
        dimension: "overworld",
        health: 18,
        food: 19,
        time: 6000,
        isRaining: false,
        isDay: true,
      }});
    }
    if (u.pathname === "/nearby") {
      return jsonResponse({ ok: true, data: {
        blocks: [{ name: "grass_block" }, { name: "oak_log" }, { name: "grass_block" }],
        entities: [{ kind: "player", type: "player", distance: 3, health: 17, position: { x: 12.2, y: 64, z: 7.9 } }],
        hazards: [],
      }});
    }
    if (u.pathname === "/inventory") {
      return jsonResponse({ ok: true, data: { items: { oak_planks: 4 } } });
    }
    if (u.pathname === "/marks") {
      return jsonResponse({ ok: true, data: { marks: { home: { x: 1, y: 64, z: 1 } } } });
    }
    if (u.pathname === "/blocks") {
      if (overrides.blocksOk === false) {
        return jsonResponse({ ok: false, error: "boom" }, false, 500);
      }
      const format = u.searchParams.get("format");
      return jsonResponse({ ok: true, data: { format, text: `${format}-grid`, count: 405, elapsed_ms: 1 } });
    }
    throw new Error(`unexpected URL ${url}`);
  };
}

describe("composeWorldState mBit context", () => {
  it("injects deterministic bot-centered navigation mBit grids with legend and hint", async () => {
    const requests = [];
    installFakeBotFetch(requests);

    const ws = await composeWorldState({ botUrl: "http://bot.test", intent: "Go to the player safely" });

    assert.equal(ws.mbit_context.purpose, "navigation");
    assert.deepEqual(ws.mbit_context.center, { x: 10, y: 64, z: 5 });
    assert.match(ws.mbit_context.legend, /binary: 0 = walkable/);
    assert.match(ws.mbit_context.interpretation_hint, /For navigation/);
    assert.deepEqual(ws.mbit_context.grids.map((g) => g.format), ["binary", "surface", "rows"]);
    assert.deepEqual(ws.mbit_context.grids.map((g) => g.bounds), [
      { x1: 6, y1: 64, z1: 1, x2: 14, y2: 65, z2: 9 },
      { x1: 6, y1: 63, z1: 1, x2: 14, y2: 67, z2: 9 },
      { x1: 6, y1: 64, z1: 1, x2: 14, y2: 67, z2: 9 },
    ]);
    assert.deepEqual(ws.mbit_context.grids.map((g) => g.text), ["binary-grid", "surface-grid", "rows-grid"]);

    const blockRequests = requests.filter((r) => r.pathname === "/blocks");
    assert.equal(blockRequests.length, 3);
    assert.deepEqual(blockRequests.map((r) => r.params.format), ["binary", "surface", "rows"]);
    const expectedByFormat = {
      binary: { x1: "6", y1: "64", z1: "1", x2: "14", y2: "65", z2: "9" },
      surface: { x1: "6", y1: "63", z1: "1", x2: "14", y2: "67", z2: "9" },
      rows: { x1: "6", y1: "64", z1: "1", x2: "14", y2: "67", z2: "9" },
    };
    for (const req of blockRequests) {
      const expected = expectedByFormat[req.params.format];
      assert.equal(req.params.x1, expected.x1);
      assert.equal(req.params.y1, expected.y1);
      assert.equal(req.params.z1, expected.z1);
      assert.equal(req.params.x2, expected.x2);
      assert.equal(req.params.y2, expected.y2);
      assert.equal(req.params.z2, expected.z2);
      assert.equal(req.params.cx, "10");
      assert.equal(req.params.cz, "5");
    }
  });

  it("uses a compact 4x4x4 full grid for verification-style intents", async () => {
    const requests = [];
    installFakeBotFetch(requests);

    const ws = await composeWorldState({ botUrl: "http://bot.test", intent: "Verify the block changed after placing it" });

    assert.equal(ws.mbit_context.purpose, "verification");
    assert.deepEqual(ws.mbit_context.grids[0].bounds, { x1: 9, y1: 63, z1: 4, x2: 12, y2: 66, z2: 7 });
    assert.deepEqual(ws.mbit_context.grids.map((g) => g.format), ["full"]);
    assert.match(ws.mbit_context.interpretation_hint, /4x4x4 full voxel sample/);
  });

  it("keeps canonical world_state usable if mBit fetch fails", async () => {
    const requests = [];
    installFakeBotFetch(requests, { blocksOk: false });

    const ws = await composeWorldState({ botUrl: "http://bot.test", intent: "Go to the player safely" });

    assert.deepEqual(ws.bot_position, [10, 64, 5]);
    assert.deepEqual(ws.nearby_blocks, ["grass_block", "oak_log"]);
    assert.equal(ws.mbit_context.ok, false);
    assert.match(ws.mbit_context.error, /500/);
  });
});
