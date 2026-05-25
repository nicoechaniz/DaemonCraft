// Lightweight fake bot for testing MotionController internals.
// Does NOT require a real Minecraft server.
// Phase 0 scaffolding tests.

import { MotionController } from '../lib/motion-controller.js';

let failed = 0;

const test = async (name, fn) => {
  try {
    await Promise.resolve(fn());
    console.log(`  PASS: ${name}`);
  } catch (e) {
    console.error(`  FAIL: ${name}`);
    console.error(`    ${e.message}`);
    failed++;
    process.exitCode = 1;
  }
};

const makeFakeBot = () => ({
  entity: {
    position: { x: 100, y: 64, z: 100, offset: (dx, dy, dz) => ({ x: 100+dx, y: 64+dy, z: 100+dz }) },
    yaw: 0,
    pitch: 0,
    onGround: true,
  },
  pathfinder: {
    _goal: null,
    setGoal: function(g) { this._goal = g; },
    getGoal: function() { return this._goal; },
    stop: function() { this._goal = null; },
    isMoving: function() { return false; },
  },
  controls: { forward: false, back: false, left: false, right: false, jump: false, sneak: false },
  setControlState: function(k, v) { this.controls[k] = v; },
  clearControlStates: function() { Object.keys(this.controls).forEach(k => this.controls[k] = false); },
  look: async function(yaw, pitch) { this.entity.yaw = yaw; return Promise.resolve(); },
  blockAt: function() { return { name: 'air', boundingBox: 'empty' }; },
  canDigBlock: function() { return false; },
  dig: async function() { return Promise.resolve(); },
  stopDigging: function() {},
  emit: function() {},
  on: function() {},
  once: function() {},
  removeAllListeners: function() {},
});

console.log('Running Phase 0 MotionController tests...\n');

// Test 1: dispose clears interval
await test('dispose clears interval', () => {
  const fake = makeFakeBot();
  const mc = new MotionController(fake);
  // Interval should be running
  if (!mc._fastStuckInterval) throw new Error('expected _fastStuckInterval after ctor');
  mc.dispose();
  if (mc._fastStuckInterval !== null) throw new Error('_fastStuckInterval not cleared');
  if (mc._active !== false) throw new Error('_active not false');
  if (mc._recovering !== false) throw new Error('_recovering not false');
});

// Test 2: _clearControls clears all controls
await test('_clearControls clears all controls', () => {
  const fake = makeFakeBot();
  const mc = new MotionController(fake);
  // Set some controls true via the bot's setter (simulates real usage)
  fake.setControlState('forward', true);
  fake.setControlState('jump', true);
  fake.setControlState('sneak', true);
  if (!fake.controls.forward || !fake.controls.jump) throw new Error('setup failed');
  mc._clearControls();
  const c = fake.controls;
  if (c.forward || c.back || c.left || c.right || c.jump || c.sneak) {
    throw new Error('not all controls cleared: ' + JSON.stringify(c));
  }
  mc.dispose();
});

// Test 3: _withControls cleans up on error
await test('_withControls cleans up on error', async () => {
  const fake = makeFakeBot();
  const mc = new MotionController(fake);
  fake.setControlState('forward', true);
  let threw = false;
  try {
    await mc._withControls(async () => {
      fake.setControlState('jump', true);
      throw new Error('boom');
    });
  } catch (e) {
    if (e.message !== 'boom') throw e;
    threw = true;
  }
  if (!threw) throw new Error('expected throw');
  const c = fake.controls;
  if (c.forward || c.jump || c.back || c.left || c.right || c.sneak) {
    throw new Error('controls not cleaned after error: ' + JSON.stringify(c));
  }
  mc.dispose();
});

// Test 4: _resumeGoal with GoalNear creates GoalNear
await test('_resumeGoal with GoalNear creates GoalNear', () => {
  const fake = makeFakeBot();
  const mc = new MotionController(fake);
  const desc = { type: 'near', x: 105, y: 64, z: 102, range: 3 };
  const ok = mc._resumeGoal(desc);
  if (!ok) throw new Error('expected _resumeGoal to return true');
  const g = fake.pathfinder.getGoal();
  if (!g) throw new Error('no goal set');
  if (g.constructor.name !== 'GoalNear') throw new Error('expected GoalNear, got ' + g.constructor.name);
  if (g.x !== 105 || g.y !== 64 || g.z !== 102) throw new Error('wrong coords');
  mc.dispose();
});

// Test 5: _resumeGoal with follow returns false
await test('_resumeGoal with follow returns false', () => {
  const fake = makeFakeBot();
  const mc = new MotionController(fake);
  const desc = { type: 'follow', entity: { username: 'test' }, distance: 2 };
  const ok = mc._resumeGoal(desc);
  if (ok !== false) throw new Error('expected false for follow');
  // goal should remain null (no change)
  if (fake.pathfinder.getGoal() !== null) throw new Error('should not have set a goal for follow');
  mc.dispose();
});

console.log(`\nPhase 0 tests complete. Failures: ${failed}`);
if (failed > 0) {
  process.exit(1);
}
