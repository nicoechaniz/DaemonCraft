// Offline contract tests for the current MotionController implementation.
// No Minecraft server is required.

import { MotionController, SESSION_STATE, makeGoalDescriptor, createSession } from '../lib/motion-controller.js';
import { BodyMutex } from '../lib/mutex.js';

let failed = 0;

const test = async (name, fn) => {
  try {
    await fn();
    console.log(`  PASS: ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  FAIL: ${name}`);
    console.error(`    ${error.stack || error.message}`);
  }
};

const nextTick = () => new Promise(resolve => setTimeout(resolve, 0));

function makeFakeBot() {
  const listeners = new Map();
  const position = {
    x: 100.5,
    y: 64,
    z: 100.5,
    offset(dx, dy, dz) {
      return { x: this.x + dx, y: this.y + dy, z: this.z + dz };
    },
  };

  const addListener = (event, fn, once = false) => {
    const entries = listeners.get(event) || [];
    entries.push({ fn, once });
    listeners.set(event, entries);
  };

  const removeListener = (event, fn) => {
    listeners.set(event, (listeners.get(event) || []).filter(entry => entry.fn !== fn));
  };

  const emit = (event, ...args) => {
    const entries = [...(listeners.get(event) || [])];
    listeners.set(event, entries.filter(entry => !entry.once));
    for (const entry of entries) entry.fn(...args);
  };

  return {
    entity: {
      position,
      velocity: { x: 0, y: 0, z: 0 },
      yaw: 0,
      pitch: 0,
      onGround: true,
    },
    pathfinder: {
      _goal: null,
      setGoal(goal) { this._goal = goal; },
      getGoal() { return this._goal; },
      stop() { this._goal = null; },
      isMoving() { return false; },
    },
    controls: {
      forward: false,
      back: false,
      left: false,
      right: false,
      jump: false,
      sneak: false,
      sprint: false,
    },
    setControlState(key, value) { this.controls[key] = value; },
    clearControlStates() {
      for (const key of Object.keys(this.controls)) this.controls[key] = false;
    },
    async look(yaw, pitch) {
      this.entity.yaw = yaw;
      this.entity.pitch = pitch;
    },
    blockAt() { return { name: 'air', boundingBox: 'empty' }; },
    canDigBlock() { return false; },
    async dig() {},
    stopDigging() {},
    emit,
    on(event, fn) { addListener(event, fn, false); },
    once(event, fn) { addListener(event, fn, true); },
    removeListener,
    removeAllListeners() { listeners.clear(); },
  };
}

function makeController() {
  const bot = makeFakeBot();
  const controller = new MotionController(bot);
  controller._log = () => {};
  return { bot, controller };
}

console.log('Running current MotionController contract tests...\n');

await test('createSession initializes the canonical navigation state', () => {
  const descriptor = makeGoalDescriptor('near', 5, 70, 6, 3);
  const session = createSession('session-1', descriptor, 5000);
  if (session.state !== SESSION_STATE.NAVIGATING) throw new Error(`unexpected state ${session.state}`);
  if (session.goalDescriptor.range !== 3) throw new Error('near range was not preserved');
  if (session.cancelRequested || session.hardCancelled) throw new Error('new session starts cancelled');
});

await test('goal descriptors preserve block, near, and follow contracts', () => {
  const block = makeGoalDescriptor('block', 1.9, 64.8, 3.2);
  const near = makeGoalDescriptor('near', 4, 65, 6);
  const entity = { username: 'Nico' };
  const follow = makeGoalDescriptor('follow', 0, 0, 0, entity, 4);
  if (block.x !== 1 || block.y !== 64 || block.z !== 3) throw new Error('block descriptor is not floored');
  if (near.range !== 2) throw new Error('near default range changed');
  if (follow.entity !== entity || follow.distance !== 4) throw new Error('follow descriptor lost entity/distance');
});

await test('dispose clears the interval and active session', () => {
  const { controller } = makeController();
  controller._session = createSession('active', makeGoalDescriptor('block', 1, 2, 3));
  controller.dispose();
  if (controller._fastStuckInterval !== null) throw new Error('stuck interval was not cleared');
  if (controller._session !== null) throw new Error('active session was not cleared');
});

await test('_clearControls clears every physical control', () => {
  const { bot, controller } = makeController();
  for (const key of Object.keys(bot.controls)) bot.setControlState(key, true);
  controller._clearControls();
  if (Object.values(bot.controls).some(Boolean)) throw new Error(`controls remain active: ${JSON.stringify(bot.controls)}`);
  controller.dispose();
});

await test('_withControls clears controls after an exception', async () => {
  const { bot, controller } = makeController();
  let threw = false;
  try {
    await controller._withControls(async () => {
      bot.setControlState('forward', true);
      throw new Error('expected failure');
    });
  } catch (error) {
    threw = error.message === 'expected failure';
  }
  if (!threw) throw new Error('the wrapped error was not propagated');
  if (Object.values(bot.controls).some(Boolean)) throw new Error('controls were not cleaned');
  controller.dispose();
});

await test('goto creates a session and resolves on goal_reached', async () => {
  const { bot, controller } = makeController();
  const resultPromise = controller.goto(105, 64, 105, 1000);
  await nextTick();
  const session = controller._session;
  if (!session || session.state !== SESSION_STATE.NAVIGATING) throw new Error('goto did not create a navigating session');
  bot.emit('goal_reached');
  const result = await resultPromise;
  if (!result.ok || !result.result.includes('Arrived at')) throw new Error(`unexpected goto result: ${JSON.stringify(result)}`);
  if (controller._session !== null) throw new Error('completed goto left an active session');
  controller.dispose();
});

await test('stop cancels an active goto and resolves its promise', async () => {
  const { controller } = makeController();
  const resultPromise = controller.goto(110, 64, 110, 1000);
  await nextTick();
  const session = controller._session;
  await controller.stop();
  const result = await resultPromise;
  if (session.state !== SESSION_STATE.CANCELLED || !session.hardCancelled) throw new Error('stop did not hard-cancel the old session');
  if (!result.result.includes('cancelled')) throw new Error(`unexpected stop result: ${JSON.stringify(result)}`);
  if (controller._session !== null) throw new Error('stop left an active session');
  controller.dispose();
});

await test('follow remains active until stop', async () => {
  const { bot, controller } = makeController();
  const entity = { username: 'Nico', position: bot.entity.position };
  const result = await controller.follow(entity, 3);
  if (!result.ok || !controller.isActive) throw new Error('follow did not become active');
  if (controller._session.goalDescriptor.entity !== entity) throw new Error('follow session lost its entity');
  await controller.stop();
  if (controller.isActive) throw new Error('follow remained active after stop');
  controller.dispose();
});

await test('_classifyBlocked recognizes a one-block step', () => {
  const { bot, controller } = makeController();
  bot.blockAt = point => {
    const dy = point.y - bot.entity.position.y;
    const dz = point.z - bot.entity.position.z;
    if (Math.abs(dz - 1) < 0.01 && Math.abs(dy - 0.4) < 0.01) {
      return { name: 'dirt', boundingBox: 'block' };
    }
    return { name: 'air', boundingBox: 'empty' };
  };
  if (controller._classifyBlocked() !== 'step') throw new Error('one-block obstacle was not classified as step');
  controller.dispose();
});

await test('normal mutex cancellation pauses without hard-cancelling the session', async () => {
  const { bot, controller } = makeController();
  const session = createSession('mutex', makeGoalDescriptor('block', 10, 64, 10));
  controller._session = session;
  bot.pathfinder.setGoal({ name: 'active-goal' });
  await controller.requestMutexCancel('runner');
  if (!session.cancelRequested) throw new Error('normal mutex cancellation was not recorded');
  if (session.hardCancelled) throw new Error('normal mutex cancellation became a hard cancellation');
  if (controller._session !== session) throw new Error('normal mutex cancellation removed the resumable session');
  if (bot.pathfinder.getGoal() !== null) throw new Error('pathfinder goal was not paused');
  controller.dispose();
});

await test('mutex cancellation defers without mutation during atomic recovery', async () => {
  const { controller } = makeController();
  const session = createSession('atomic', makeGoalDescriptor('block', 10, 64, 10));
  session.state = SESSION_STATE.RECOVERY_ATOMIC;
  controller._session = session;
  await controller.requestMutexCancel('runner');
  if (session.cancelRequested || session.hardCancelled) throw new Error('atomic recovery was mutated by a deferred cancel');
  if (controller._session !== session) throw new Error('atomic recovery session was removed');
  controller.dispose();
});

await test('emergency stop hard-cancels and clears the session', async () => {
  const { bot, controller } = makeController();
  const session = createSession('emergency', makeGoalDescriptor('block', 10, 64, 10));
  session.state = SESSION_STATE.RECOVERY_ATOMIC;
  controller._session = session;
  bot.pathfinder.setGoal({ name: 'active-goal' });
  await controller.requestEmergencyStop('operator');
  if (!session.hardCancelled || session.state !== SESSION_STATE.CANCELLED) throw new Error('emergency stop did not hard-cancel');
  if (controller._session !== null) throw new Error('emergency stop left a session');
  if (bot.pathfinder.getGoal() !== null) throw new Error('emergency stop left a goal');
  controller.dispose();
});

await test('BodyMutex emergencyStop delegates to MotionController', async () => {
  const bot = makeFakeBot();
  let requester = null;
  bot.motion = { async requestEmergencyStop(value) { requester = value; } };
  const mutex = new BodyMutex(bot);
  mutex.mode = 2;
  mutex.owner = 'runner';
  const result = await mutex.emergencyStop('operator');
  if (!result.ok || requester !== 'operator') throw new Error('BodyMutex did not delegate the emergency stop');
  if (mutex.mode !== 0 || mutex.owner !== null) throw new Error('BodyMutex did not return to idle');
});

await test('stuck handling without a step resumes the original goal', async () => {
  const { bot, controller } = makeController();
  const descriptor = makeGoalDescriptor('block', 120, 64, 120);
  const session = createSession('stuck-flat', descriptor);
  session.state = SESSION_STATE.STUCK_DETECTED;
  controller._session = session;
  controller._sessionGeneration += 1;
  controller._currentPath = [];
  await controller._handleStuck(session);
  if (session.state !== SESSION_STATE.NAVIGATING) throw new Error(`unexpected state ${session.state}`);
  if (bot.pathfinder.getGoal()?.constructor?.name !== 'GoalBlock') throw new Error('original block goal was not resumed');
  controller.dispose();
});

await test('stuck handling with a step dispatches only the step recovery FSM', async () => {
  const { controller } = makeController();
  const descriptor = makeGoalDescriptor('block', 120, 65, 120);
  const session = createSession('stuck-step', descriptor);
  session.state = SESSION_STATE.STUCK_DETECTED;
  controller._session = session;
  controller._sessionGeneration += 1;
  controller._currentPath = [{ x: 101, y: 65, z: 101 }];
  let calls = 0;
  controller._doStepRecoveryFSM = async activeSession => {
    calls += 1;
    activeSession.state = SESSION_STATE.NAVIGATING;
  };
  await controller._handleStuck(session);
  if (controller._recoveryPromise) await controller._recoveryPromise;
  if (calls !== 1) throw new Error(`step recovery called ${calls} times`);
  if (controller._activeRecovery) throw new Error('recovery flag was not cleared');
  controller.dispose();
});

console.log(`\nMotionController contract tests complete. Failures: ${failed}`);
if (failed > 0) process.exit(1);
