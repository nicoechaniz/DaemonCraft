/**
 * Tests for registry normalization (REG_KEY) + real cancellation contracts.
 * Covers GAP #1 + #2 fixes: alias mapping, ON_ABORT dispatch via REG_KEY,
 * bounded 750ms abort in mutex/server paths, performance.now for atomic deadlines.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { REG_KEY, ACTION_REGISTRY, ON_ABORT } from '../lib/action-registry.js';
import { BodyMutex } from '../lib/mutex.js';

// Mock bot with minimal surface used by ON_ABORT and mutex paths
function makeMockBot() {
  const state = {
    stopDiggingCalled: false,
    synced: false,
    controls: {},
  };
  const listeners = {};
  const bot = {
    clearControlStates() { /* no-op */ },
    stopDigging() { state.stopDiggingCalled = true; },
    setControlState(k, v) { state.controls[k] = v; },
    async syncInventory() { state.synced = true; },
    blockAt(pos) { return { name: 'air' }; }, // simulate failed place for ON_ABORT branch
    entity: { onGround: true, position: { x:0, y:0, z:0 } },
    once(ev, fn) { listeners[ev] = fn; setTimeout(() => fn && fn(), 5); },
    emit(ev, data) { /* no-op */ },
    // expose for asserts
    _getState() { return state; },
  };
  return bot;
}

test('REG_KEY normalizes URL names to registry keys', () => {
  assert.equal(REG_KEY('dig'), 'mine_block');
  assert.equal(REG_KEY('collect'), 'mine_block');
  assert.equal(REG_KEY('place'), 'place_block');
  assert.equal(REG_KEY('place_fill'), 'place_block');
  assert.equal(REG_KEY('goto'), 'goto'); // passthrough
  assert.equal(REG_KEY('unknown'), 'unknown');
});

test('ACTION_REGISTRY has aliases for direct lookup + canonical defs shared', () => {
  assert.ok(ACTION_REGISTRY['dig']);
  assert.ok(ACTION_REGISTRY['place']);
  assert.ok(ACTION_REGISTRY['collect']);
  assert.ok(ACTION_REGISTRY['place_fill']);
  assert.equal(ACTION_REGISTRY['dig'].tag, 'preemptible');
  assert.equal(ACTION_REGISTRY['place'].tag, 'atomic');
  assert.equal(ACTION_REGISTRY['place'], ACTION_REGISTRY['place_block']); // shared object
  assert.equal(ACTION_REGISTRY['dig'], ACTION_REGISTRY['mine_block']);
});

test('ON_ABORT has canonical keys only (mine_block, place_block, jump)', () => {
  assert.ok(ON_ABORT['mine_block']);
  assert.ok(ON_ABORT['place_block']);
  assert.ok(ON_ABORT['jump']);
  assert.strictEqual(ON_ABORT['dig'], undefined);
});

test('ON_ABORT.mine_block is defensive and calls stopDigging', async () => {
  const bot = makeMockBot();
  await ON_ABORT['mine_block'](bot, { targetPos: null });
  assert.equal(bot._getState().stopDiggingCalled, true);
});

test('ON_ABORT.place_block recovers inventory only on air target (failed place)', async () => {
  const bot = makeMockBot();
  await ON_ABORT['place_block'](bot, { targetPos: { x: 1, y: 2, z: 3 } });
  assert.equal(bot._getState().synced, true); // target was air in mock
});

test('BodyMutex uses performance.now() for atomicDeadline (monotonic)', async () => {
  const bot = makeMockBot();
  const mutex = new BodyMutex(bot);
  // claim an atomic with short maxMs
  const res = await mutex.claimCritical('test', 'place', 50);
  assert.equal(res.allowed, true);
  const status = mutex.getStatus();
  // performance.now() values are small (ms since process start), not unix epoch ~1.7e12
  assert.ok(status.atomicDeadline > 0);
  assert.ok(status.atomicDeadline < 1e10, 'atomicDeadline should be performance.now() based, not Date.now() epoch');
  // After short time, still may be active but deadline is future perf time
  await new Promise(r => setTimeout(r, 10));
});

test('BodyMutex._cancelCurrent fires ON_ABORT via REG_KEY with 750ms cap (no deadlock)', async () => {
  const bot = makeMockBot();
  const mutex = new BodyMutex(bot);
  // Simulate a running actionTag set to url-name 'dig' (common case from /action before normalization awareness)
  mutex.actionTag = 'dig';
  const start = performance.now();
  await mutex._cancelCurrent();
  const dur = performance.now() - start;
  assert.ok(dur < 1000, 'ON_ABORT path must complete fast (<1s even on timeout)');
  // stopDigging called in new path
  assert.equal(bot._getState().stopDiggingCalled, true);
});

test('ON_ABORT timeout path is exercised without hanging (simulated slow handler)', async () => {
  // Temporarily patch a slow ON_ABORT to verify race abandons it
  const orig = ON_ABORT['jump'];
  ON_ABORT['jump'] = async () => { await new Promise(r => setTimeout(r, 2000)); };
  const bot = makeMockBot();
  const mutex = new BodyMutex(bot);
  mutex.actionTag = 'jump';
  const start = performance.now();
  await mutex._cancelCurrent(); // should race and abandon after 750
  const dur = performance.now() - start;
  assert.ok(dur < 1100, 'slow ON_ABORT must be abandoned by 750ms timeout + margin');
  ON_ABORT['jump'] = orig; // restore
});
