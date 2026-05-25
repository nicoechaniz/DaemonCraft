# MotionController Refactor — Implementation Plan

## Overview

**Goal:** Replace the current collection of competing fixes in MotionController with a single-owner, FSM-based motion/recovery system that cannot be interrupted mid-maneuver.

**Branch:** `feat/reactive-runner-phase1` (base: `b09a1e7`)

**Files that will be modified:**
- `agents/bot/lib/motion-controller.js` — major rewrite
- `agents/bot/lib/mutex.js` — light changes (route through MotionController)
- `agents/bot/server.js` — light changes (use motion API, dispose on reconnect)
- `agents/bot/lib/action-registry.js` — no changes (already written, just integrate)
- New: `agents/bot/tests/test-motion-controller.js` — fake bot tests

**Files that will NOT be modified:**
- `agents/runner/thread.py` — runner keeps using BodyMutex HTTP API
- `agents/agent_loop.py` — no changes
- `agents/embodied-service/` — no changes
- `gateway/` — no changes

**Golden rule:** Each commit must leave the bot in a runnable state. Never commit a broken intermediate.

---

## Phase 0 — Scaffolding (commit 1 of 4)

### Step 0.1: Create test file

Create new file: `agents/bot/tests/test-motion-controller.js`

```javascript
// Lightweight fake bot for testing MotionController internals.
// Does NOT require a real Minecraft server.

const test = (name, fn) => {
  try {
    fn();
    console.log(`  PASS: ${name}`);
  } catch (e) {
    console.error(`  FAIL: ${name}`);
    console.error(`    ${e.message}`);
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
});
```

### Step 0.2: Add dispose() to MotionController

In `agents/bot/lib/motion-controller.js`, add this method:

```javascript
dispose() {
  if (this._fastStuckInterval) {
    clearInterval(this._fastStuckInterval);
    this._fastStuckInterval = null;
  }
  this._active = false;
  this._recovering = false;
}
```

Verification: Call `dispose()` then check: is `_fastStuckInterval` null? Is `_active` false? Is `_recovering` false?

### Step 0.3: Call dispose() before replacing bot

In `agents/bot/server.js`, in the `createBot()` function, before `bot = null` or re-assignment lines, add:

```javascript
if (motion) {
  motion.dispose();
  motion = null;
}
```

Find the exact line where bot is reassigned. Insert these 4 lines before that line.

Verification: After `POST /connect` (reconnect), old MotionController interval should be stopped. Check with: add a `console.log` in the fast stuck interval and verify it only fires once per bot instance, not accumulating.

### Step 0.4: Add control helper methods to MotionController

Add these four methods inside the MotionController class:

```javascript
// Clear all physical controls safely
_clearControls() {
  const b = this.bot;
  if (!b) return;
  try { b.setControlState('forward', false); } catch {}
  try { b.setControlState('back', false); } catch {}
  try { b.setControlState('left', false); } catch {}
  try { b.setControlState('right', false); } catch {}
  try { b.setControlState('jump', false); } catch {}
  try { b.setControlState('sneak', false); } catch {}
}

// Pause pathfinder (clear goal but don't change session state)
async _pausePathfinder() {
  try { this.bot.pathfinder.setGoal(null); } catch {}
  await new Promise(r => setTimeout(r, 100));
}

// Resume original goal from a goal descriptor
_resumeGoal(goalDescriptor) {
  if (!goalDescriptor || !goalDescriptor.type) return false;
  const { goals } = require('mineflayer-pathfinder').default || require('mineflayer-pathfinder');
  if (!goals) return false;
  let goal;
  if (goalDescriptor.type === 'block') {
    goal = new goals.GoalBlock(goalDescriptor.x, goalDescriptor.y, goalDescriptor.z);
  } else if (goalDescriptor.type === 'near') {
    goal = new goals.GoalNear(goalDescriptor.x, goalDescriptor.y, goalDescriptor.z, goalDescriptor.range || 2);
  } else if (goalDescriptor.type === 'follow') {
    // Follow is special: we don't resume follow after disruption.
    // It needs live entity reference. Return false to signal "cannot resume".
    return false;
  }
  if (goal) {
    this.bot.pathfinder.setGoal(goal);
    return true;
  }
  return false;
}

// Execute control sequence with guaranteed cleanup
async _withControls(fn) {
  try {
    await fn();
  } finally {
    this._clearControls();
  }
}
```

Verification: Call `_clearControls()` after setting some controls. Check all are false. Call `_withControls(async () => { throw new Error('crash'); })` and verify controls are still cleared after.

### Step 0.5: Wrap existing recovery control sequences with try/finally

Find every place where `setControlState('forward', true)` or similar is called in recovery methods, and wrap with `_withControls`:

In `_doStepRecoveryInternal` (lines ~162-189): wrap the body after `_pausePathfinder()` with `_withControls(async () => { ... })`.

In `_doLateralRecovery` (lines ~192-240): wrap the control sequence (lines 202-230) with `_withControls(async () => { ... })`.

Do NOT change behavior yet. Only add try/finally wrapper.

Verification: Node --check passes. Bot can still do goto/follow without breaking.

### Step 0.6: Write and run Phase 0 tests

Test 1: `dispose` clears interval
Test 2: `_clearControls` clears all controls
Test 3: `_withControls` cleans up on error
Test 4: `_resumeGoal` with GoalNear descriptor creates GoalNear
Test 5: `_resumeGoal` with follow descriptor returns false

Run with: `node agents/bot/tests/test-motion-controller.js`

All must pass before commit.

### Step 0.7: Commit

```bash
git add agents/bot/lib/motion-controller.js agents/bot/server.js agents/bot/tests/test-motion-controller.js
git commit -m "Phase 0: scaffolding — dispose, control helpers, try/finally, tests"
```

---

## Phase 1 — Motion Session + Goal Descriptor (commit 2 of 4)

### Step 1.1: Define MotionSession object

Inside `motion-controller.js`, add this class BEFORE the MotionController class:

```javascript
const SESSION_STATE = {
  IDLE: 'idle',
  NAVIGATING: 'navigating',
  STUCK_DETECTED: 'stuck_detected',
  RECOVERY_ATOMIC: 'recovery_atomic',
  REPLANNING: 'replanning',
  COMPLETE: 'complete',
  CANCELLED: 'cancelled',
  FAILED: 'failed',
};

function makeGoalDescriptor(type, x, y, z, rangeOrEntity, distance) {
  if (type === 'block') return { type: 'block', x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) };
  if (type === 'near') return { type: 'near', x: Math.floor(x), y: Math.floor(y), z: Math.floor(z), range: rangeOrEntity || 2 };
  if (type === 'follow') return { type: 'follow', entity: rangeOrEntity, distance: distance || 2 };
  return null;
}

function createSession(id, goalDescriptor, timeoutMs = 15000) {
  return {
    id,
    goalDescriptor,
    state: SESSION_STATE.NAVIGATING,
    recoveryAttempt: 0,
    cancelRequested: false,
    hardCancelled: false,
    startedAt: Date.now(),
    deadline: Date.now() + timeoutMs,
    generation: 0,
  };
}
```

### Step 1.2: Replace _active / _recovering / _targetGoal with session

In MotionController constructor, REMOVE these:
- `this._active = false;`
- `this._recovering = false;`
- `this._targetGoal = null;`

ADD these:
- `this._session = null; // active MotionSession or null`
- `this._sessionGeneration = 0; // monotonic counter`

Add helper:

```javascript
get isActive() { return this._session !== null && this._session.state !== SESSION_STATE.IDLE; }
```

### Step 1.3: Rewrite goto() to use session

New `goto()` logic:

```javascript
async goto(x, y, z, timeoutMs = 15000) {
  await this.stop();
  const sessionId = `goto_${Date.now()}`;
  const goalDescriptor = makeGoalDescriptor('block', x, y, z);
  const session = createSession(sessionId, goalDescriptor, timeoutMs);
  this._session = session;
  this._sessionGeneration++;

  // Reset fast stuck window
  this._resetFastStuckWindow();

  const goal = new goals.GoalBlock(Math.floor(x), Math.floor(y), Math.floor(z));
  const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs));
  try {
    await Promise.race([this.bot.pathfinder.goto(goal), timeout]);
    session.state = SESSION_STATE.COMPLETE;
    return { ok: true, result: `Arrived at ${Math.round(x)}, ${Math.round(y)}, ${Math.round(z)}` };
  } catch (e) {
    const p = this.bot.entity.position;
    if (e.message === 'timeout') {
      session.state = SESSION_STATE.FAILED;
      return { ok: true, result: `Walked toward ${Math.round(x)},${Math.round(y)},${Math.round(z)}, now at ${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)}. Did not reach destination within timeout.` };
    }
    if (session.hardCancelled) {
      session.state = SESSION_STATE.CANCELLED;
      return { ok: true, result: `Navigation cancelled.` };
    }
    session.state = SESSION_STATE.FAILED;
    return { ok: true, result: `Navigation failed: ${e.message}.` };
  } finally {
    this._session = null;
  }
}
```

REMOVE the old finally block that conditionally cleared pathfinder — session owns cleanup now.

### Step 1.4: Rewrite gotoNear() same pattern

Same structure as goto() but with `GoalNear` and goalDescriptor type 'near'.

Key difference: `goalDescriptor = makeGoalDescriptor('near', x, y, z, range)`.

In finally block, same cleanup: `this._session = null`.

### Step 1.5: Rewrite follow() to use session

```javascript
async follow(entity, distance = 2) {
  await this.stop();
  const sessionId = `follow_${Date.now()}`;
  const goalDescriptor = makeGoalDescriptor('follow', 0, 0, 0, entity, distance);
  const session = createSession(sessionId, goalDescriptor);
  this._session = session;
  this._sessionGeneration++;
  this._resetFastStuckWindow();

  this.bot.pathfinder.setGoal(new goals.GoalFollow(entity, distance), true);
  // Follow is continuous — no await. Session stays active until stop() or failure.
  // Fast stuck detection will fire for follow too, but recovery will be limited
  // (goalDescriptor.type === 'follow' → just log, no physical recovery).
  return { ok: true, result: `Following ${entity.username || entity.name || 'entity'}.` };
}
```

### Step 1.6: Rewrite stop() for session

```javascript
async stop() {
  const prevSession = this._session;
  this._session = null;
  this._sessionGeneration++;
  this._resetFastStuckWindow();

  if (prevSession) {
    prevSession.state = SESSION_STATE.CANCELLED;
  }

  try { this.bot.pathfinder.setGoal(null); } catch {}
  try { this.bot.stopDigging(); } catch {}
  try { this.bot.clearControlStates(); } catch {}
  this._clearControls();
}
```

### Step 1.7: Update fast stuck interval to use session

Change the fast stuck interval callback:

```javascript
this._fastStuckInterval = setInterval(() => {
  const s = this._session;
  if (!s || !this.bot?.entity) return;
  // Only check during NAVIGATING or STUCK_DETECTED
  if (s.state !== SESSION_STATE.NAVIGATING && s.state !== SESSION_STATE.STUCK_DETECTED) return;
  if (s.cancelRequested) return;
  // Check displacement ...
  // (keep displacement check logic, just use session state instead of _recovering)
  // ...
  const moved = Math.sqrt(dx*dx + dz*dz);
  if (moved < FAST_STUCK_MIN_PROGRESS_M) {
    if (this._stuckCheckT0 === 0) this._stuckCheckT0 = Date.now();
    if (Date.now() - this._stuckCheckT0 >= FAST_STUCK_TRIGGER_MS) {
      s.state = SESSION_STATE.STUCK_DETECTED;
      this._stuckCheckT0 = 0;
      // ENQUEUE recovery, don't fire-and-forget
      this._handleStuck(s);
    }
  } else {
    this._stuckCheckT0 = 0;
    if (s.state === SESSION_STATE.STUCK_DETECTED) {
      s.state = SESSION_STATE.NAVIGATING; // unstuck
    }
  }
  // ...
}, FAST_STUCK_CHECK_INTERVAL_MS);
```

### Step 1.8: Write and run Phase 1 tests

Test 1: createSession creates session with NAVIGATING state
Test 2: makeGoalDescriptor for 'near' includes range
Test 3: goto sets session in NAVIGATING state
Test 4: stop() transitions session to CANCELLED
Test 5: dispose() clears session and interval

### Step 1.9: Commit

```bash
git commit -am "Phase 1: MotionSession + goal descriptor — single session owner"
```

---

## Phase 2 — Recovery FSM + Deterministic Maneuvers (commit 3 of 4)

This is the core phase. Every step must be verified with the live bot.

### Step 2.1: Define recovery stages

Add these constants above the MotionController class:

```javascript
const RECOVERY_STAGE = {
  IDLE: 'idle',
  REQUESTING_SAFE_CANCEL: 'requesting_safe_cancel',
  PAUSING_PATHFINDER: 'pausing_pathfinder',
  BACKSTEP: 'backstep',
  ROTATING: 'rotating',
  JUMP_FORWARD: 'jump_forward',
  ROTATING_LATERAL: 'rotating_lateral',
  STRAFE_AWAY: 'strafe_away',
  MEASURING: 'measuring',
  MINE_TARGET: 'mine_target',
  RESUME: 'resume',
  DONE: 'done',
  FAILED: 'failed',
};
```

### Step 2.2: Implement recovery entry point

`_handleStuck(session)` method:

```javascript
async _handleStuck(session) {
  if (!session || session.state !== SESSION_STATE.STUCK_DETECTED) return;
  if (this._activeRecovery) return; // already recovering
  this._activeRecovery = true;
  const gen = this._sessionGeneration;
  const initialPos = { ...this.bot.entity.position };

  try {
    session.state = SESSION_STATE.RECOVERY_ATOMIC;
    session.recoveryAttempt++;

    const blocked = this._classifyBlocked();
    this._log(`recovery attempt=${session.recoveryAttempt} direction=${blocked}`);

    if (session.hardCancelled) return;

    if (blocked === 'step' || blocked === 'unknown') {
      await this._doStepRecoveryFSM(session, gen);
    } else if (blocked === 'left' || blocked === 'right' || blocked === 'forward-left' || blocked === 'forward-right') {
      await this._doLateralRecoveryFSM(session, gen, blocked);
    } else if (blocked === 'forward') {
      await this._doMineRecoveryFSM(session, gen);
    } else {
      await this._doStepRecoveryFSM(session, gen); // fallback
    }
  } catch (e) {
    this._log(`recovery error: ${e.message}`);
    session.state = SESSION_STATE.FAILED;
  } finally {
    this._activeRecovery = false;
    this._clearControls();
  }
}
```

### Step 2.3: Step recovery FSM (THE KEY METHOD)

```javascript
async _doStepRecoveryFSM(session, generation) {
  // Guard: bail if session changed or cancelled
  if (this._sessionGeneration !== generation) return;

  // Stage 1: Pause pathfinder
  await this._pausePathfinder();

  // Stage 2: Backstep
  this.bot.setControlState('sneak', true);
  this.bot.setControlState('back', true);
  await new Promise(r => setTimeout(r, 260));
  this._clearControls();

  // Stage 3: Determine rotation
  // Prefer rotating away from nearest solid block. Fallback: alternate direction.
  const yaw = this.bot.entity.yaw;
  // Try to find the nearest solid in body footprint
  const bodyBlock = this._findNearestBodyBlock();
  let targetYaw;
  if (bodyBlock) {
    // Rotate away from nearest obstruction
    targetYaw = yaw + (this._recoverySpinDir || Math.PI / 3);
  } else {
    // Alternate direction each attempt
    const alt = session.recoveryAttempt % 2 === 0 ? 1 : -1;
    targetYaw = yaw + alt * 0.5 * Math.PI;
  }
  // Round to nearest 22.5° for clean measurement
  targetYaw = Math.round(targetYaw / (Math.PI / 8)) * (Math.PI / 8);

  // Stage 4: Rotate
  await this.bot.look(targetYaw, 0, false);

  // Stage 5: Jump forward
  const preJump = { x: this.bot.entity.position.x, y: this.bot.entity.position.y, z: this.bot.entity.position.z };
  this.bot.setControlState('jump', true);
  this.bot.setControlState('forward', true);
  await new Promise(r => setTimeout(r, 600));
  this._clearControls();
  await new Promise(r => setTimeout(r, 200)); // let physics settle

  // Stage 6: Measure
  const postJump = this.bot.entity.position;
  const dx = postJump.x - preJump.x;
  const dy = postJump.y - preJump.y;
  const dz = postJump.z - preJump.z;
  const moved = Math.sqrt(dx*dx + dz*dz);
  this._log(`step recovery result: dx=${dx.toFixed(2)} dy=${dy.toFixed(2)} dz=${dz.toFixed(2)} moved=${moved.toFixed(2)}`);

  // Stage 7: Resume if progress, else fail
  if (dy > 0.3 || moved > 1.0) {
    // Clearance achieved
    this._resetFastStuckWindow();
    if (session.goalDescriptor) {
      this._resumeGoal(session.goalDescriptor);
      session.state = SESSION_STATE.NAVIGATING;
    } else {
      session.state = SESSION_STATE.COMPLETE;
    }
    this._log('step recovery: resumed navigation');
  } else {
    this._log('step recovery: no progress, marking failed');
    session.state = SESSION_STATE.FAILED;
  }
}
```

### Step 2.4: Lateral recovery FSM (THE OTHER KEY METHOD)

```javascript
async _doLateralRecoveryFSM(session, generation, blockedDir) {
  if (this._sessionGeneration !== generation) return;

  // Stage 1: Pause pathfinder
  await this._pausePathfinder();

  // Stage 2: Determine obstacle direction in WORLD frame
  // blockedDir is from _classifyBlocked: 'left', 'right', etc.
  // Compute obstacle normal vector in world coords
  const yaw = this.bot.entity.yaw;
  let obstacleWorldDx, obstacleWorldDz;
  if (blockedDir === 'left' || blockedDir === 'forward-left') {
    obstacleWorldDx = -Math.cos(yaw);
    obstacleWorldDz = -Math.sin(yaw);
  } else {
    obstacleWorldDx = Math.cos(yaw);
    obstacleWorldDz = Math.sin(yaw);
  }
  // Normalize
  const len = Math.sqrt(obstacleWorldDx**2 + obstacleWorldDz**2) || 1;
  const obsNx = obstacleWorldDx / len;
  const obsNz = obstacleWorldDz / len;

  // Stage 3: Rotate away from obstacle
  let targetYaw;
  if (blockedDir === 'left' || blockedDir === 'forward-left') {
    targetYaw = yaw + 0.5; // turn right ~28.6°
  } else {
    targetYaw = yaw - 0.5; // turn left ~28.6°
  }
  await this.bot.look(targetYaw, 0, false);
  await new Promise(r => setTimeout(r, 150)); // let look settle

  // Stage 4: NOW measure in new rotated frame
  const preStrafe = { x: this.bot.entity.position.x, y: this.bot.entity.position.y, z: this.bot.entity.position.z };
  // Re-check clearance in new orientation
  const newBlocked = this._classifyBlocked();
  // Determine strafe direction: away from obstacle normal
  const newYaw = this.bot.entity.yaw;
  const rightDx = Math.cos(newYaw);
  const rightDz = Math.sin(newYaw);
  const leftDx = -rightDx;
  const leftDz = -rightDz;

  // Dot product: which direction has a positive projection away from obstacle?
  const dotRight = rightDx * obsNx + rightDz * obsNz;
  // If obstacle is to our right (dotRight positive → right points toward obstacle), strafe LEFT
  // If obstacle is to our left (dotRight negative → left points toward obstacle), strafe RIGHT
  const strafeRight = dotRight < 0;

  // Stage 5: Strafe away
  this.bot.setControlState('sneak', true);
  if (strafeRight) {
    this.bot.setControlState('right', true);
  } else {
    this.bot.setControlState('left', true);
  }
  await new Promise(r => setTimeout(r, LATERAL_STRAFE_MS));
  this._clearControls();
  await new Promise(r => setTimeout(r, 200));

  // Stage 6: Measure separation from obstacle
  const postStrafe = this.bot.entity.position;
  const dispDx = postStrafe.x - preStrafe.x;
  const dispDz = postStrafe.z - preStrafe.z;
  const separation = dispDx * obsNx + dispDz * obsNz; // dot product with away direction

  this._log(`lateral recovery: separation=${separation.toFixed(2)}`);

  // Stage 7: Resume if separation increased
  if (separation < -0.3) { // negative means moved away from obstacle
    // Also verify no longer blocked
    const recheck = this._classifyBlocked();
    if (recheck === 'left' || recheck === 'right' || recheck === 'forward-left' || recheck === 'forward-right') {
      this._log('lateral recovery: still blocked after strafe, trying step instead');
      await this._doStepRecoveryFSM(session, generation);
      return;
    }
    this._resetFastStuckWindow();
    if (session.goalDescriptor) {
      this._resumeGoal(session.goalDescriptor);
      session.state = SESSION_STATE.NAVIGATING;
    } else {
      session.state = SESSION_STATE.COMPLETE;
    }
    this._log('lateral recovery: resumed navigation');
  } else {
    this._log('lateral recovery: insufficient separation, trying step recovery');
    await this._doStepRecoveryFSM(session, generation);
  }
}
```

### Step 2.5: Convert mine recovery to FSM pattern

```javascript
async _doMineRecoveryFSM(session, generation) {
  if (this._sessionGeneration !== generation) return;
  await this._pausePathfinder();

  // Find block in front
  const b = this.bot;
  const facing = b.entity.position.offset(-Math.sin(b.entity.yaw), 1.5, Math.cos(b.entity.yaw));
  const block = b.blockAt(facing);

  if (block && block.name !== 'air' && b.canDigBlock(block)) {
    this._log(`recovery: mining ${block.name}`);
    try {
      await b.dig(block, true);
      this._log('recovery: mined successfully');
    } catch (e) {
      this._log(`recovery: dig failed (${e.message}), trying step`);
      await this._doStepRecoveryFSM(session, generation);
      return;
    }
  } else {
    this._log(`recovery: no mineable block, trying step`);
    await this._doStepRecoveryFSM(session, generation);
    return;
  }

  this._resetFastStuckWindow();
  if (session.goalDescriptor) {
    this._resumeGoal(session.goalDescriptor);
    session.state = SESSION_STATE.NAVIGATING;
  }
  this._log('recovery: resumed after mining');
}
```

### Step 2.6: Add _findNearestBodyBlock helper

```javascript
_findNearestBodyBlock() {
  const b = this.bot;
  if (!b) return null;
  const yaw = b.entity.yaw;
  const pos = b.entity.position;
  const fwdDx = -Math.sin(yaw), fwdDz = Math.cos(yaw);
  const leftDx = -Math.cos(yaw), leftDz = -Math.sin(yaw);
  const rightDx = Math.cos(yaw), rightDz = Math.sin(yaw);

  const dirs = [
    { dx: fwdDx, dz: fwdDz, name: 'forward' },
    { dx: leftDx, dz: leftDz, name: 'left' },
    { dx: rightDx, dz: rightDz, name: 'right' },
  ];
  const BODY = [0.4, 0.9, 1.4, 1.9];

  let nearest = null;
  let nearestDist = Infinity;

  for (const dir of dirs) {
    for (const h of BODY) {
      const pt = pos.offset(dir.dx, h, dir.dz);
      const blk = b.blockAt(pt);
      if (blk && blk.name !== 'air' && blk.name !== 'cave_air' && blk.name !== 'void_air' && blk.boundingBox === 'block') {
        const dist = Math.abs(dir.dx) + Math.abs(dir.dz);
        if (dist < nearestDist) {
          nearestDist = dist;
          nearest = { block: blk, direction: dir.name };
        }
      }
    }
  }
  return nearest;
}
```

### Step 2.7: Update _classifyBlocked step detection

Fix the step-vs-forward ambiguity. Move step check BEFORE body check for low blocks:

```javascript
_classifyBlocked() {
  // ... same as before but reorder:
  
  // Tier 0: Check if there's specifically a 1-block-tall obstacle at feet level
  // that has air above it (this is a step). This runs first.
  if (_isSolidAt(fwdDx, fwdDz, [0.4])) {
    // There's a block at feet level ahead
    if (!_isSolidAt(fwdDx, fwdDz, [1.4])) {
      // Air at head level → this is a step, not a full body block
      return 'step';
    }
  }

  // Tier 1: body-level blocks
  // (rest same as before)
  // ...
}
```

### Step 2.8: Remove old recovery methods

DELETE these old methods:
- `_doMineRecovery()` (old, not FSM)
- `_doLateralRecovery()` (old, not FSM)
- `_doStepRecovery()` (old, not FSM)
- `_doStepRecoveryInternal()` (old, not FSM)
- `_recoveryDone` field (unused)

KEEP the new FSM versions from steps 2.3-2.5.

### Step 2.9: Write and run Phase 2 tests

Test 1: Step recovery sequence: backstep → rotate → jump → measure
Test 2: Lateral recovery: rotate before measure, strafe away from obstacle
Test 3: Mine recovery: dig block, fallback to step if no block
Test 4: _classifyBlocked returns 'step' for 1-block-tall obstacle with air above
Test 5: Recovery FSM clears controls in all exit paths

### Step 2.10: Live test protocol

Before committing, test with the live bot:

1. Start bot in lab mode: `systemctl --user restart daemoncraft-cast.service`

2. Test step recovery:
   - Place bot in front of a 1-block step
   - `curl -s -X POST http://localhost:3003/action/goto -H 'Content-Type: application/json' -d '{"x":..., "y":..., "z":...}'`
   - Watch logs for `recovery attempt=1 direction=step`
   - Verify sequence: `backstep` → rotation → `jump forward` → `resumed navigation`
   - Verify bot actually reaches destination

3. Test lateral recovery:
   - Create 1-wide corridor with obstacle on one side
   - Issue goto command
   - Watch logs for `recovery attempt=N direction=left` or `right`
   - Verify: `rotating` → `strafe away` with separation measurement
   - Verify bot reaches destination

4. Test no double recovery:
   - Watch for fast, repeated recovery during a single navigation session
   - Should see at most 1 recovery trigger per session
   - If recovery fails, session should go to FAILED, not retry endlessly

### Step 2.11: Commit

```bash
git commit -am "Phase 2: Recovery FSM — deterministic step/lateral/mine recovery"
```

---

## Phase 3 — BodyMutex Integration + Action Registry (commit 4 of 4)

### Step 3.1: Remove pathfinder from BodyMutex

In `agents/bot/lib/mutex.js`, change `_cancelCurrent()`:

```javascript
async _cancelCurrent() {
  if (!this.bot) return;
  // Route through MotionController — do NOT touch pathfinder directly
  if (this.bot.motion) {
    try { await this.bot.motion.requestMutexCancel(this.owner || 'mutex'); } catch {}
  }
  try { this.bot.clearControlStates(); } catch {}
}
```

REMOVE:
- `try { this.bot.pathfinder.stop(); } catch {}`

### Step 3.2: Add requestMutexCancel to MotionController

```javascript
async requestMutexCancel(requester) {
  if (!this._session) return;
  this._session.cancelRequested = true;

  // If in recovery atomic, don't interrupt — just flag
  if (this._session.state === SESSION_STATE.RECOVERY_ATOMIC || this._activeRecovery) {
    this._log(`cancel requested by ${requester} during recovery — deferring`);
    return;
  }

  // Normal cancel: stop pathfinder
  this._session.hardCancelled = true;
  try { this.bot.pathfinder.setGoal(null); } catch {}
  this._clearControls();
}

async requestEmergencyStop(requester) {
  // Emergency: always stop, even mid-recovery
  if (this._session) {
    this._session.hardCancelled = true;
    this._session.state = SESSION_STATE.CANCELLED;
  }
  this._activeRecovery = false;
  try { this.bot.pathfinder.setGoal(null); } catch {}
  this._clearControls();
  this._session = null;
}
```

### Step 3.3: Update BodyMutex emergencyStop

In `mutex.js`:

```javascript
async emergencyStop(requester) {
  const previous = { mode: this.mode, owner: this.owner };
  // Route through MotionController
  if (this.bot && this.bot.motion) {
    await this.bot.motion.requestEmergencyStop(requester);
  }
  this.mode = CONTROL_MODE.IDLE;
  this.owner = null;
  this.actionTag = null;
  this.since = Date.now();
  this.atomicDeadline = 0;
  return { ok: true, previousMode: previous.mode, previousOwner: previous.owner };
}
```

### Step 3.4: Wrap action endpoint with ACTION_REGISTRY

In `agents/bot/server.js`, in the `/action/ACTION` handler (lines ~4614-4641), before `actionInProgress = true`, add:

```javascript
// Check if action requires GOAL or ATOMIC claim
const actionDef = ACTION_REGISTRY[actionName];
if (actionDef) {
  let mutexClaimed = false;
  if (actionDef.bodyCategory === 'movement' || actionDef.bodyCategory === 'navigation') {
    // Movement actions implicitly claim GOAL via MotionController session
    // No explicit mutex claim needed — session IS the claim
  } else if (actionDef.bodyCategory === 'interaction') {
    // Short interactions: claim atomic
    if (bodyMutex && actionDef.maxMs) {
      const claimResult = await bodyMutex.claimCritical('action:' + actionName, actionName, actionDef.maxMs);
      if (!claimResult.allowed) {
        return respond(res, 423, { ok: false, error: claimResult.reason || 'body busy' });
      }
      mutexClaimed = true;
    }
  }
  // ... run action ...
  // In finally: if mutexClaimed, release
}
```

This is light integration. Full Action Registry integration should be a follow-up Kanban task, not part of this refactor.

### Step 3.5: Remove direct pathfinder calls from server.js helpers

Find all calls to `bot.pathfinder.setGoal()` or `bot.clearControlStates()` outside MotionController:

- `climbStaircase()` (server.js around line 957-967): replace control states with a MotionController helper or mark as known exception (it's a local staircase tool)
- `sendToMcChat()`: no changes needed
- combat controls (server.js around line 3148-3244): mark as known runner-owned path for now, but add a comment: `// TODO: route through motion.requestReflex(requester)`

For this phase, just add comments. Don't break the runner.

### Step 3.6: Verify server.js uses motion.stop() not raw pathfinder

Search for `bot.pathfinder.setGoal(null)` in server.js outside of:
- MotionController (motion-controller.js)
- createBot initialization

Any remaining should either:
- Be `motion.stop()` instead, OR
- Have a comment explaining why it must be raw

### Step 3.7: Write and run Phase 3 tests

Test 1: `requestMutexCancel` during navigation sets cancelRequested
Test 2: `requestMutexCancel` during recovery defers, doesn't corrupt
Test 3: `requestEmergencyStop` clears session even mid-recovery
Test 4: BodyMutex.emergencyStop calls motion.requestEmergencyStop

### Step 3.8: Live integration test

1. Start bot
2. Start a long goto: `curl -s -X POST ... /action/goto ...`
3. Immediately request runner critical claim:
   `curl -s -X POST http://localhost:3003/mutex/claim -H 'Content-Type: application/json' -d '{"requester":"test","critical":true,"actionTag":"test"}'`
4. Request stop:
   `curl -s -X POST http://localhost:3003/action/stop`
5. Verify no control states left stuck
6. Verify session is CANCELLED
7. Issue new goto — should work clean

### Step 3.9: Commit

```bash
git commit -am "Phase 3: BodyMutex routes through MotionController; emergency stop safe"
```

---

## Phase Checklist Summary

| Phase | Commits | Test pass | Live verified |
|-------|---------|-----------|---------------|
| 0 — Scaffolding | 1 | Yes | Basic go/follow |
| 1 — Session | 1 | Yes | GotoNear range |
| 2 — Recovery FSM | 1 | Yes | Step + lateral |
| 3 — Mutex integration | 1 | Yes | Stop during goto |

---

## What we do NOT do in this plan

- Do NOT change the runner (thread.py, event_poller.py, agent_loop.py)
- Do NOT change the embodied service or Gemma-Andy
- Do NOT change the gateway
- Do NOT add new HTTP endpoints (yet)
- Do NOT optimize fast stuck parameters (they're tunable later)

---

## Regression test script

After all 4 commits, run this script:

```bash
#!/bin/bash
BOT=http://localhost:3003

echo "=== Test 1: follow ==="
curl -s -X POST $BOT/action/follow -H 'Content-Type: application/json' -d '{"player":"NicoElViejoGamer"}'
sleep 2

echo "=== Test 2: goto near ==="
curl -s -X POST $BOT/action/goto_near -H 'Content-Type: application/json' -d '{"x":540,"y":96,"z":-820,"range":3}'
sleep 1

echo "=== Test 3: stop during navigation ==="
curl -s -X POST $BOT/action/stop
sleep 1

echo "=== Test 4: new goto after stop ==="
curl -s -X POST $BOT/action/goto -H 'Content-Type: application/json' -d '{"x":540,"y":96,"z":-820}'
sleep 1

echo "=== Test 5: status ==="
curl -s $BOT/status | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'ok={d.get(\"ok\")} pos={d.get(\"data\",{}).get(\"position\")}')"

echo "=== Test 6: consecutive gotos ==="
curl -s -X POST $BOT/action/goto -H 'Content-Type: application/json' -d '{"x":540,"y":96,"z":-820}'
sleep 0.5
curl -s -X POST $BOT/action/goto -H 'Content-Type: application/json' -d '{"x":542,"y":96,"z":-820}'
sleep 1

echo "=== All tests complete ==="
```

Expected: All return `ok:true`. No controls stuck. Bot not teleported away. Session states transition correctly in logs.
