import test from 'node:test';
import assert from 'node:assert/strict';

import {
  hasVerticalProgress,
  shouldStopAtOpenSky,
  yawForCardinal,
} from '../lib/escape-macro-policy.js';

test('open-sky guard stops normal escape macros at the surface', () => {
  assert.equal(shouldStopAtOpenSky({ skyHeadroom: 96, openCardinals: 2 }), true);
});

test('human-directed open-shaft recovery can disable the open-sky guard', () => {
  assert.equal(shouldStopAtOpenSky({
    stopOnOpenSky: false,
    skyHeadroom: 96,
    openCardinals: 4,
  }), false);
});

test('guard does not stop before both surface criteria are met', () => {
  assert.equal(shouldStopAtOpenSky({ skyHeadroom: 95, openCardinals: 4 }), false);
  assert.equal(shouldStopAtOpenSky({ skyHeadroom: 96, openCardinals: 1 }), false);
});

test('vertical progress requires a stable block-level ascent', () => {
  assert.equal(hasVerticalProgress(69, 70), true);
  assert.equal(hasVerticalProgress(69.1, 69.9), false);
  assert.equal(hasVerticalProgress(70.1, 69.9), false);
});

test('cardinal yaw follows Mineflayer x=-sin(yaw), z=-cos(yaw)', () => {
  const expected = {
    north: { x: 0, z: -1 },
    south: { x: 0, z: 1 },
    east: { x: 1, z: 0 },
    west: { x: -1, z: 0 },
  };
  for (const [direction, vector] of Object.entries(expected)) {
    const yaw = yawForCardinal(direction);
    assert.ok(Math.abs(-Math.sin(yaw) - vector.x) < 1e-9, `${direction} x`);
    assert.ok(Math.abs(-Math.cos(yaw) - vector.z) < 1e-9, `${direction} z`);
  }
});