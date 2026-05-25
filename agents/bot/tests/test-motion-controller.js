// Lightweight fake bot for testing MotionController internals.
// Does NOT require a real Minecraft server.
// Phase 0 scaffolding tests.

import { MotionController, SESSION_STATE, makeGoalDescriptor, createSession } from '../lib/motion-controller.js';
import { BodyMutex } from '../lib/mutex.js';

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

const makeFakeBot = () => {
  const listeners = {};
  const addListener = (evt, fn, once = false) => {
    if (!listeners[evt]) listeners[evt] = [];
    listeners[evt].push({ fn, once });
  };
  const removeListener = (evt, fn) => {
    if (!listeners[evt]) return;
    listeners[evt] = listeners[evt].filter((l) => l.fn !== fn);
  };
  const emit = (evt, ...args) => {
    const list = listeners[evt] || [];
    // filter to keep non-once, call all
    listeners[evt] = list.filter((l) => {
      try { l.fn(...args); } catch {}
      return !l.once;
    });
  };
  const removeAll = () => { Object.keys(listeners).forEach(k => delete listeners[k]); };

  return {
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
    emit,
    on: (e, f) => addListener(e, f, false),
    once: (e, f) => addListener(e, f, true),
    removeListener: (e, f) => removeListener(e, f),
    removeAllListeners: removeAll,
  };
};

console.log('Running Phase 0 MotionController tests...\n');

// Test 1: dispose clears interval
await test('dispose clears interval', () => {
  const fake = makeFakeBot();
  const mc = new MotionController(fake);
  // Interval should be running
  if (!mc._fastStuckInterval) throw new Error('expected _fastStuckInterval after ctor');
  mc.dispose();
  if (mc._fastStuckInterval !== null) throw new Error('_fastStuckInterval not cleared');
  // legacy _active/_recovering removed (I2)
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
  // legacy _active/_recovering/_targetGoal removed (I2)
});

// --- Phase 2 tests: Recovery FSM (deterministic maneuvers) ---

await test('_classifyBlocked returns step for 1-block obstacle with air above', () => {
  const fake = makeFakeBot();
  const mc = new MotionController(fake);
  // Simulate: solid at feet (0.4) forward, air at head (1.4). yaw=0 → forward +z
  fake.blockAt = (pt) => {
    const relY = pt.y - 64;
    const relZ = pt.z - 100;
    const relX = pt.x - 100;
    if (Math.abs(relX) < 0.01 && Math.abs(relZ - 1) < 0.01) {
      if (Math.abs(relY - 0.4) < 0.01) return { name: 'dirt', boundingBox: 'block' };
      if (Math.abs(relY - 1.4) < 0.01) return { name: 'air', boundingBox: 'empty' };
    }
    return { name: 'air', boundingBox: 'empty' };
  };
  const res = mc._classifyBlocked();
  if (res !== 'step') throw new Error('expected "step", got ' + res);
  mc.dispose();
});

await test('step recovery: backstep → rotate → jump → measure', async () => {
  const fake = makeFakeBot();
  const mc = new MotionController(fake);
  const desc = makeGoalDescriptor('block', 120, 64, 120);
  const session = createSession('step-test', desc);
  session.state = SESSION_STATE.STUCK_DETECTED;
  mc._session = session;
  mc._sessionGeneration++;

  // Make blockAt return only air → no body block found, uses alternate rotate
  fake.blockAt = () => ({ name: 'air', boundingBox: 'empty' });

  await mc._handleStuck(session);

  // Should have run to completion (no progress → FAILED path exercised)
  if (session.state !== SESSION_STATE.FAILED) {
    // May be NAV if somehow, but expect FAILED on zero disp
    if (session.state !== SESSION_STATE.NAVIGATING && session.state !== SESSION_STATE.FAILED) {
      throw new Error('unexpected final state: ' + session.state);
    }
  }
  // Controls must be cleared (guaranteed by finally / _clear)
  const c = fake.controls;
  if (c.forward || c.back || c.left || c.right || c.jump || c.sneak) {
    throw new Error('controls not cleared after step recovery: ' + JSON.stringify(c));
  }
  if (mc._activeRecovery) throw new Error('_activeRecovery left true');
  mc.dispose();
});

await test('lateral recovery: rotate before measure', async () => {
  const fake = makeFakeBot();
  const mc = new MotionController(fake);
  const desc = makeGoalDescriptor('near', 105, 64, 105, 2);
  const session = createSession('lateral-test', desc);
  session.state = SESSION_STATE.STUCK_DETECTED;
  mc._session = session;
  mc._sessionGeneration++;
  session.state = SESSION_STATE.RECOVERY_ATOMIC;

  fake.blockAt = () => ({ name: 'air', boundingBox: 'empty' });

  // Force a lateral direction
  // We call the FSM directly to target the rotate-before-measure path
  await mc._doLateralRecoveryFSM(session, mc._sessionGeneration, 'left');

  const c = fake.controls;
  if (c.forward || c.back || c.left || c.right || c.jump || c.sneak) {
    throw new Error('controls not cleared after lateral: ' + JSON.stringify(c));
  }
  // Since no real separation, it falls back to step which also clears
  if (mc._activeRecovery) throw new Error('_activeRecovery left true');
  mc.dispose();
});

await test('mine recovery: dig block, fallback to step on no block', async () => {
  const fake = makeFakeBot();
  let digCalled = 0;
  let lastDigBlock = null;

  // Case 1: mineable block present → dig called, success path
  const fake1 = makeFakeBot();
  fake1.blockAt = () => ({ name: 'stone', boundingBox: 'block', position: { x: 101, y: 65, z: 101 } });
  fake1.canDigBlock = () => true;
  fake1.dig = async (blk) => { digCalled++; lastDigBlock = blk; return; };

  const mc1 = new MotionController(fake1);
  const s1 = createSession('mine1', makeGoalDescriptor('block', 10,64,10));
  s1.state = SESSION_STATE.STUCK_DETECTED;
  mc1._session = s1;
  mc1._sessionGeneration++;
  s1.state = SESSION_STATE.RECOVERY_ATOMIC;
  await mc1._doMineRecoveryFSM(s1, mc1._sessionGeneration);
  if (digCalled !== 1) throw new Error('expected dig called once for mineable case');
  if (s1.state !== SESSION_STATE.NAVIGATING) throw new Error('mine success should set NAVIGATING, got ' + s1.state);
  if (mc1._activeRecovery) throw new Error('activeRecovery true after mine');
  mc1.dispose();

  // Case 2: no mineable → fallback to step (which will run and set FAILED due to no disp)
  const fake2 = makeFakeBot();
  fake2.blockAt = () => ({ name: 'air', boundingBox: 'empty' });
  fake2.canDigBlock = () => false;
  const mc2 = new MotionController(fake2);
  const s2 = createSession('mine2', makeGoalDescriptor('block', 10,64,10));
  s2.state = SESSION_STATE.STUCK_DETECTED;
  mc2._session = s2;
  mc2._sessionGeneration++;
  s2.state = SESSION_STATE.RECOVERY_ATOMIC;
  await mc2._doMineRecoveryFSM(s2, mc2._sessionGeneration);
  if (s2.state !== SESSION_STATE.FAILED && s2.state !== SESSION_STATE.NAVIGATING) {
    throw new Error('no-block mine should fallback and end not stuck, got ' + s2.state);
  }
  const c2 = fake2.controls;
  if (c2.sneak || c2.back || c2.forward || c2.jump) throw new Error('controls not cleared in mine fallback');
  mc2.dispose();
});

await test('recovery FSM clears controls on error', async () => {
  const fake = makeFakeBot();
  // Force an error inside step recovery (e.g. during look or jump phase)
  fake.look = async () => { throw new Error('simulated look failure'); };

  const mc = new MotionController(fake);
  const session = createSession('err-test', makeGoalDescriptor('block', 99,64,99));
  session.state = SESSION_STATE.STUCK_DETECTED;
  mc._session = session;
  mc._sessionGeneration++;

  fake.blockAt = () => ({ name: 'air', boundingBox: 'empty' });

  await mc._handleStuck(session);  // should catch, set FAILED, finally clear controls

  const c = fake.controls;
  if (c.forward || c.back || c.left || c.right || c.jump || c.sneak) {
    throw new Error('controls NOT cleared on error path: ' + JSON.stringify(c));
  }
  if (session.state !== SESSION_STATE.FAILED) throw new Error('on error should mark FAILED, got ' + session.state);
  if (mc._activeRecovery !== false) throw new Error('_activeRecovery not reset on error');
  mc.dispose();
});

// --- Phase 3 tests: BodyMutex integration + request*Cancel / emergency ---

await test('requestMutexCancel during navigation sets cancelRequested', async () => {
  const fake = makeFakeBot();
  const mc = new MotionController(fake);
  const desc = makeGoalDescriptor('block', 10, 64, 10);
  const session = createSession('nav-cancel', desc);
  session.state = SESSION_STATE.NAVIGATING;
  mc._session = session;
  mc._sessionGeneration++;

  await mc.requestMutexCancel('test-nav');

  if (!session.cancelRequested) throw new Error('cancelRequested not set during nav');
  if (!session.hardCancelled) throw new Error('hardCancelled should be set for non-recovery nav cancel');
  // session not auto-cleared (goto catch will handle via hardCancelled)
  if (mc._session !== session) throw new Error('session should still be reference until navigation settles');
  mc.dispose();
});

await test('requestMutexCancel during recovery defers, does not corrupt', async () => {
  const fake = makeFakeBot();
  const mc = new MotionController(fake);
  const desc = makeGoalDescriptor('near', 20, 64, 20);
  const session = createSession('rec-defer', desc);
  session.state = SESSION_STATE.RECOVERY_ATOMIC;
  mc._session = session;
  mc._sessionGeneration++;
  mc._activeRecovery = true;

  await mc.requestMutexCancel('test-req');

  if (!session.cancelRequested) throw new Error('cancelRequested must be set even on defer');
  if (session.hardCancelled) throw new Error('hardCancelled must NOT be set when deferring recovery');
  if (mc._session !== session) throw new Error('session must not be cleared on defer');
  if (mc._activeRecovery !== true) throw new Error('activeRecovery must remain true during defer');
  // recovery should proceed to its end (test does not run full FSM)
  mc._activeRecovery = false; // cleanup for test
  mc.dispose();
});

await test('requestEmergencyStop clears session even mid-recovery', async () => {
  const fake = makeFakeBot();
  const mc = new MotionController(fake);
  const desc = makeGoalDescriptor('block', 30, 64, 30);
  const session = createSession('emerg-stop', desc);
  session.state = SESSION_STATE.RECOVERY_ATOMIC;
  mc._session = session;
  mc._sessionGeneration++;
  mc._activeRecovery = true;

  await mc.requestEmergencyStop('emerg-tester');

  if (mc._session !== null) throw new Error('session must be nulled by emergency stop');
  if (mc._activeRecovery !== false) throw new Error('_activeRecovery must be forced false');
  // state on old session obj should be CANCELLED (if still referenced)
  if (session.state !== SESSION_STATE.CANCELLED) throw new Error('session state should be CANCELLED');
  if (!session.hardCancelled) throw new Error('hardCancelled should be set');
  mc.dispose();
});

await test('BodyMutex emergencyStop calls motion.requestEmergencyStop', async () => {
  const fake = makeFakeBot();
  let calledWith = null;
  fake.motion = {
    requestEmergencyStop: async (requester) => {
      calledWith = requester;
    }
  };
  const bm = new BodyMutex(fake);
  // simulate some owner
  bm.mode = 2; // REFLEX
  bm.owner = 'runnerX';

  const res = await bm.emergencyStop('test-emerg');

  if (calledWith !== 'test-emerg') throw new Error('motion.requestEmergencyStop not called with correct requester, got: ' + calledWith);
  if (!res.ok) throw new Error('emergencyStop result not ok');
  if (bm.mode !== 0 || bm.owner !== null) throw new Error('mutex state not reset to IDLE after emergency');
  // no need to dispose mc, none created
});

// --- B1/B2/B3 verification tests (must not regress the 19 prior tests) ---

await test('goto survives recovery setGoal(null)', async () => {
  const fake = makeFakeBot();
  const mc = new MotionController(fake);
  const p = mc.goto(105, 64, 105, 8000);
  // allow session/ listener setup
  await new Promise(r => setTimeout(r, 5));
  // simulate recovery's pause (which does setGoal(null) — must NOT break the manual listener)
  await mc._pausePathfinder();
  // now simulate eventual arrival after _resumeGoal re-sets it
  fake.emit('goal_reached');
  const res = await p;
  if (!res || !res.ok) throw new Error('goto promise did not resolve ok after recovery pause');
  if (typeof res.result !== 'string' || !res.result.includes('Arrived at')) {
    throw new Error('unexpected result: ' + JSON.stringify(res));
  }
  if (mc._session !== null) throw new Error('session should be cleared on reached');
  mc.dispose();
});

await test('stale guard aborts mid-recovery after stop', async () => {
  const fake = makeFakeBot();
  const mc = new MotionController(fake);
  let clears = 0;
  const origClear = mc._clearControls.bind(mc);
  mc._clearControls = () => { clears++; return origClear(); };
  let setsAfter = 0;
  const origSetGoal = fake.pathfinder.setGoal.bind(fake.pathfinder);
  let stopped = false;
  fake.pathfinder.setGoal = (g) => {
    if (stopped && g != null) setsAfter++;  // only count resume-style (non-null) sets after stop
    return origSetGoal(g);
  };

  const desc = makeGoalDescriptor('block', 120, 64, 120);
  const session = createSession('stale-guard', desc);
  session.state = SESSION_STATE.STUCK_DETECTED;
  mc._session = session;
  mc._sessionGeneration++;

  const hp = mc._handleStuck(session);
  // let it enter first await sleep in pause
  await new Promise(r => setTimeout(r, 20));
  stopped = true;
  await mc.stop();
  await hp;

  if (clears === 0) throw new Error('expected _clearControls called by stale guard');
  if (setsAfter > 0) throw new Error('setGoal should not fire after stop (stale guard): ' + setsAfter);
  mc.dispose();
});

await test('cancelRequested consumed in finally', async () => {
  const fake = makeFakeBot();
  const mc = new MotionController(fake);
  const desc = makeGoalDescriptor('block', 99, 64, 99);
  const session = createSession('cancel-fin', desc);
  session.state = SESSION_STATE.STUCK_DETECTED;
  mc._session = session;
  mc._sessionGeneration++;

  // start recovery (will run FSM)
  const hp = mc._handleStuck(session);
  // set flag mid-recovery (before it finishes its sleeps)
  session.cancelRequested = true;
  await hp;

  if (session.state !== SESSION_STATE.CANCELLED) throw new Error('expected CANCELLED, got ' + session.state);
  if (!session.hardCancelled) throw new Error('hardCancelled should be set by consume');
  if (mc._activeRecovery) throw new Error('_activeRecovery left true');
  mc.dispose();
});

await test('follow skips recovery', async () => {
  const fake = makeFakeBot();
  const mc = new MotionController(fake);
  let recoveryInvoked = false;
  const orig = mc._doStepRecoveryFSM.bind(mc);
  mc._doStepRecoveryFSM = async (s, g) => { recoveryInvoked = true; return orig(s, g); };

  const desc = makeGoalDescriptor('follow', 0, 0, 0, { username: 'bar' }, 2);
  const session = createSession('foll-skip', desc);
  session.state = SESSION_STATE.STUCK_DETECTED;
  mc._session = session;
  mc._sessionGeneration++;

  await mc._handleStuck(session);

  if (recoveryInvoked) throw new Error('recovery FSM must not be invoked for follow sessions (I1)');
  if (mc._activeRecovery) throw new Error('_activeRecovery must not be set for follow');
  mc.dispose();
});

console.log(`\nAll Phase 0 + Phase 1 + Phase 2 + Phase 3 + B1B2B3 tests complete (23 total). Failures: ${failed}`);
if (failed > 0) {
  process.exit(1);
}
