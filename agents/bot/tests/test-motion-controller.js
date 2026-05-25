// Lightweight fake bot for testing MotionController internals.
// Does NOT require a real Minecraft server.
// Phase 0 scaffolding tests.

import { MotionController, SESSION_STATE, makeGoalDescriptor, createSession } from '../lib/motion-controller.js';

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
    goto: function(g) { this._goal = g; return new Promise(() => {}); /* never settles for test */ },
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

// --- Phase 1 tests (MotionSession + goal descriptors) ---

await test('createSession creates NAVIGATING session', () => {
  const desc = makeGoalDescriptor('block', 10, 64, 20);
  const s = createSession('test1', desc, 5000);
  if (!s) throw new Error('no session');
  if (s.state !== SESSION_STATE.NAVIGATING) throw new Error('expected NAVIGATING, got ' + s.state);
  if (s.id !== 'test1') throw new Error('wrong id');
  if (s.goalDescriptor.type !== 'block' || s.goalDescriptor.x !== 10) throw new Error('bad goalDescriptor');
  if (typeof s.startedAt !== 'number' || typeof s.deadline !== 'number') throw new Error('missing times');
  if (s.recoveryAttempt !== 0 || s.cancelRequested !== false || s.hardCancelled !== false) throw new Error('bad defaults');
});

await test('makeGoalDescriptor for near includes range', () => {
  const d = makeGoalDescriptor('near', 5, 70, 5, 3);
  if (d.type !== 'near') throw new Error('wrong type');
  if (d.range !== 3) throw new Error('range not set');
  const d2 = makeGoalDescriptor('near', 1, 2, 3);
  if (d2.range !== 2) throw new Error('default range should be 2');
});

await test('goto sets session in NAVIGATING state', async () => {
  const fake = makeFakeBot();
  const mc = new MotionController(fake);
  // Call but do not await fully — check state immediately after start (before pathfinder settles)
  const p = mc.goto(200, 64, 200, 1000);
  // After the stop()+session setup, before the race, session should be set.
  // Give several ticks; the first await stop() in goto queues a microtask for continuation.
  let s = null;
  for (let i = 0; i < 5; i++) {
    await new Promise(r => setTimeout(r, 0));
    s = mc._session;
    if (s) break;
  }
  if (!s) throw new Error('expected _session after goto()');
  if (s.state !== SESSION_STATE.NAVIGATING) throw new Error('expected NAVIGATING, got ' + s.state);
  if (s.goalDescriptor.type !== 'block') throw new Error('expected block goal');
  // Cleanup
  await mc.stop();
  if (mc._session !== null) throw new Error('session not cleared after stop');
  if (mc.isActive) throw new Error('isActive should be false after stop');
  mc.dispose();
});

await test('stop transitions session to CANCELLED', async () => {
  const fake = makeFakeBot();
  const mc = new MotionController(fake);
  // Start a follow (stays active)
  mc.follow({ username: 'test', position: { x: 100, y: 64, z: 100 } }, 2);
  await new Promise(r => setTimeout(r, 0));
  const s = mc._session;
  if (!s) throw new Error('no session from follow');
  if (s.state !== SESSION_STATE.NAVIGATING) throw new Error('follow did not start navigating');
  await mc.stop();
  if (s.state !== SESSION_STATE.CANCELLED) throw new Error('stop did not set CANCELLED, got ' + s.state);
  if (mc._session !== null) throw new Error('session not nulled');
  if (mc.isActive) throw new Error('isActive true after stop');
  mc.dispose();
});

await test('dispose clears session and interval', () => {
  const fake = makeFakeBot();
  const mc = new MotionController(fake);
  mc._session = { state: SESSION_STATE.NAVIGATING };
  if (!mc._fastStuckInterval) throw new Error('no interval');
  mc.dispose();
  if (mc._fastStuckInterval !== null) throw new Error('interval not cleared');
  if (mc._session !== null) throw new Error('session not cleared');
  // Legacy flags still cleared for compat
  if (mc._active !== false) throw new Error('_active not false');
  if (mc._recovering !== false) throw new Error('_recovering not false');
});

console.log(`\nAll Phase 0 + Phase 1 tests complete. Failures: ${failed}`);
if (failed > 0) {
  process.exit(1);
}
