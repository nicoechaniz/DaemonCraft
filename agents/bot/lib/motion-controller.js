/**
 * MotionController — owns all bot.pathfinder state and provides safe navigation primitives.
 *
 * Stuck recovery: on 3 consecutive path_reset 'stuck' events, the controller
 * pauses the pathfinder, does a sprint-jump forward step, then re-sets the goal
 * so the pathfinder continues from the new position.
 */

import pathfinderPkg from 'mineflayer-pathfinder';
const { goals } = pathfinderPkg;

const FAST_STUCK_CHECK_INTERVAL_MS = 500;
const FAST_STUCK_MIN_PROGRESS_M = 0.7;
const FAST_STUCK_TRIGGER_MS = 500;
const LATERAL_STRAFE_MS = 375; // 75% of the previous 500ms displacement.

export const SESSION_STATE = {
  IDLE: 'idle',
  NAVIGATING: 'navigating',
  STUCK_DETECTED: 'stuck_detected',
  RECOVERY_ATOMIC: 'recovery_atomic',
  REPLANNING: 'replanning',
  COMPLETE: 'complete',
  CANCELLED: 'cancelled',
  FAILED: 'failed',
};

export function makeGoalDescriptor(type, x, y, z, rangeOrEntity, distance) {
  if (type === 'block') return { type: 'block', x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) };
  if (type === 'near') return { type: 'near', x: Math.floor(x), y: Math.floor(y), z: Math.floor(z), range: rangeOrEntity || 2 };
  if (type === 'follow') return { type: 'follow', entity: rangeOrEntity, distance: distance || 2 };
  return null;
}

export function createSession(id, goalDescriptor, timeoutMs = 15000) {
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

export class MotionController {
  constructor(bot) {
    this.bot = bot;
    this._stuckCount = 0;
    this._session = null; // active MotionSession or null
    this._sessionGeneration = 0; // monotonic counter
    
    bot.on('path_reset', (reason) => {
      if (reason === 'stuck' && this._active) {
        this._log(`path_reset: stuck (fast stuck handles recovery)`);
      }
    });
    bot.on('goal_reached', () => {
      this._stuckCount = 0;
      this._sameSpotCount = 0;
      this._lastCheckPos = null;
      this._stuckCheckT0 = 0;
    });

    // Fast stuck detection: every 500ms, if session active in navigating/stuck state and not moved >0.7m for 500ms, trigger.
    this._lastCheckPos = null;
    this._stuckCheckT0 = 0;
    this._fastStuckInterval = setInterval(() => {
      const s = this._session;
      if (!s || !this.bot?.entity) return;
      // Only check during NAVIGATING or STUCK_DETECTED
      if (s.state !== SESSION_STATE.NAVIGATING && s.state !== SESSION_STATE.STUCK_DETECTED) return;
      if (s.cancelRequested) return;
      const p = this.bot.entity.position;
      if (this._lastCheckPos) {
        const dx = p.x - this._lastCheckPos.x;
        const dz = p.z - this._lastCheckPos.z;
        const moved = Math.sqrt(dx*dx + dz*dz);
        if (moved < FAST_STUCK_MIN_PROGRESS_M) {
          if (this._stuckCheckT0 === 0) this._stuckCheckT0 = Date.now();
          if (Date.now() - this._stuckCheckT0 >= FAST_STUCK_TRIGGER_MS) {
            const blocked = this._classifyBlocked();
            this._log(`fast stuck: moved ${moved.toFixed(2)}m in ${(FAST_STUCK_CHECK_INTERVAL_MS/1000).toFixed(1)}s (<${FAST_STUCK_MIN_PROGRESS_M}m), direction=${blocked}`);
            this._stuckCheckT0 = 0;
            s.state = SESSION_STATE.STUCK_DETECTED;
            // Call stub (Phase 1: just log + mark FAILED; no FSM/recovery yet)
            this._handleStuck(s);
          }
        } else {
          this._stuckCheckT0 = 0;
          if (s.state === SESSION_STATE.STUCK_DETECTED) {
            s.state = SESSION_STATE.NAVIGATING; // recovered movement
          }
        }
      }
      this._lastCheckPos = { x: p.x, y: p.y, z: p.z };
    }, FAST_STUCK_CHECK_INTERVAL_MS);
  }

  _log(msg) {
    const ts = new Date().toISOString().slice(11, 23);
    console.error(`[${ts}] [motion] ${msg}`);
  }

  _resetFastStuckWindow() {
    this._lastCheckPos = null;
    this._stuckCheckT0 = 0;
  }

  get isActive() { return this._session !== null && this._session.state !== SESSION_STATE.IDLE; }

  // Check which direction is blocking. Returns 'forward', 'left',
  // 'right', 'forward-left', 'forward-right', 'step' (feet level), or 'unknown'.
  _classifyBlocked() {
    const b = this.bot;
    const yaw = b.entity.yaw;
    const pos = b.entity.position;
    
    const _isSolidAt = (dx, dz, heights) => {
      for (const h of heights) {
        const pt = pos.offset(dx, h, dz);
        const blk = b.blockAt(pt);
        if (blk && blk.name !== 'air' && blk.name !== 'cave_air' && blk.name !== 'void_air' && blk.boundingBox === 'block') {
          return true;
        }
      }
      return false;
    };

    // Direction vectors
    const fwdDx = -Math.sin(yaw), fwdDz = Math.cos(yaw);
    const leftDx = -Math.cos(yaw), leftDz = -Math.sin(yaw);
    const rightDx = Math.cos(yaw), rightDz = Math.sin(yaw);
    const fwdLeftDx = fwdDx + leftDx, fwdLeftDz = fwdDz + leftDz;
    const fwdRightDx = fwdDx + rightDx, fwdRightDz = fwdDz + rightDz;

    // Tier 1: body-level blocks (0.4-1.9) — these need mine or strafe
    const BODY = [0.4, 0.9, 1.4, 1.9];
    if (_isSolidAt(fwdDx, fwdDz, BODY)) return 'forward';
    if (_isSolidAt(fwdLeftDx, fwdLeftDz, BODY)) return 'forward-left';
    if (_isSolidAt(fwdRightDx, fwdRightDz, BODY)) return 'forward-right';
    if (_isSolidAt(leftDx, leftDz, BODY)) return 'left';
    if (_isSolidAt(rightDx, rightDz, BODY)) return 'right';
    
    // Tier 2: step ahead (block at y=1, above feet) — simple jump
    if (_isSolidAt(fwdDx, fwdDz, [1])) return 'step';
    
    // Tier 3: nothing obvious — could be stuck on edge/lip, do backstep+jump
    return 'unknown';
  }

  // Same as step recovery but mines the block in front instead of jumping
  async _doMineRecovery() {
    // NOTE: uses dig() + path pause only; no setControlState sequence, so _withControls not needed here.
    this._recovering = true;
    const b = this.bot;
    const g = this._targetGoal;
    if (!g) { this._recovering = false; return; }

    // Clear pathfinder
    try { b.pathfinder.setGoal(null); } catch {}
    await new Promise(r => setTimeout(r, 100));

    // Find the block directly in front of the bot's face
    const facing = b.entity.position.offset(
      -Math.sin(b.entity.yaw), 1.5, Math.cos(b.entity.yaw)
    );
    const block = b.blockAt(facing);
    if (block && block.name !== 'air' && b.canDigBlock(block)) {
      this._log(`recovery: mining ${block.name} at ${block.position}`);
      try {
        await b.dig(block, true);  // forceLook=true for blocks above
        this._log('recovery: block mined');
      } catch (e) {
        this._log(`recovery: dig failed (${e.message}), trying step instead`);
        await this._doStepRecoveryInternal();
        return;
      }
    } else {
      this._log(`recovery: no mineable block ahead (${block?.name || 'none'}), trying step`);
      await this._doStepRecoveryInternal();
      return;
    }

    // Resume pathfinder
    this._stuckCount = 0;
    this._sameSpotCount = 0;
    this._active = true;
    this._resetFastStuckWindow();
    b.pathfinder.setGoal(new goals.GoalBlock(Math.floor(g.x), Math.floor(g.y), Math.floor(g.z)));
    this._log('recovery: done (mined), pathfinder resumed');
    this._recovering = false;
  }

  // Extracted step recovery logic for reuse by _doMineRecovery fallback
  async _doStepRecoveryInternal() {
    const b = this.bot;
    const g = this._targetGoal;
    this._log('recovery: backstep (crouched)');
    await this._withControls(async () => {
      b.setControlState('sneak', true);
      b.setControlState('back', true);
      await new Promise(r => setTimeout(r, 260));
      b.setControlState('back', false);
      b.setControlState('sneak', false);

      const yawJitter = (Math.random() - 0.5) * 0.4 * Math.PI;
      await b.look(b.entity.yaw + yawJitter, 0, false);

      this._log('recovery: jump forward');
      b.setControlState('forward', true);
      b.setControlState('jump', true);
      await new Promise(r => setTimeout(r, 600));
      b.setControlState('jump', false);
      b.setControlState('forward', false);
    });

    this._stuckCount = 0;
    this._sameSpotCount = 0;
    this._active = true;
    this._resetFastStuckWindow();
    b.pathfinder.setGoal(new goals.GoalBlock(Math.floor(g.x), Math.floor(g.y), Math.floor(g.z)));
    this._log('recovery: done (step), pathfinder resumed');
    this._recovering = false;
  }

  // Lateral recovery: crouch-backstep → turn away from obstacle → strafe → resume
  async _doLateralRecovery(blockedSide) {
    this._recovering = true;
    const b = this.bot;
    const g = this._targetGoal;
    if (!g) { this._recovering = false; return; }

    // Clear pathfinder
    try { b.pathfinder.setGoal(null); } catch {}
    await new Promise(r => setTimeout(r, 100));

    // Crouch backstep + strafe sequence wrapped for guaranteed cleanup
    await this._withControls(async () => {
      // Crouch backstep to disengage from obstacle
      this._log(`recovery lateral(${blockedSide}): crouch backstep`);
      b.setControlState('sneak', true);
      b.setControlState('back', true);
      await new Promise(r => setTimeout(r, 200));
      b.setControlState('back', false);
      b.setControlState('sneak', false);

      // Turn away from the obstacle and strafe
      const strafeDir = blockedSide === 'left' ? 1 : -1;  // +1 = right, -1 = left
      const yawAdjust = blockedSide === 'left' ? -0.3 : 0.3;  // turn slightly away
      await b.look(b.entity.yaw + yawAdjust, 0, false);

      this._log(`recovery lateral: crouch strafe ${strafeDir > 0 ? 'right' : 'left'} + forward (${LATERAL_STRAFE_MS}ms)`);
      b.setControlState('sneak', true);
      if (strafeDir > 0) {
        b.setControlState('right', true);
      } else {
        b.setControlState('left', true);
      }
      b.setControlState('forward', true);
      await new Promise(r => setTimeout(r, LATERAL_STRAFE_MS));
      b.setControlState('forward', false);
      if (strafeDir > 0) {
        b.setControlState('right', false);
      } else {
        b.setControlState('left', false);
      }
      b.setControlState('sneak', false);
    });

    // Resume pathfinder
    this._stuckCount = 0;
    this._sameSpotCount = 0;
    this._active = true;
    this._resetFastStuckWindow();
    b.pathfinder.setGoal(new goals.GoalBlock(Math.floor(g.x), Math.floor(g.y), Math.floor(g.z)));
    this._log('recovery: done (lateral), pathfinder resumed');
    this._recovering = false;
  }

  async _doStepRecovery() {
    this._recovering = true;
    this._recoveryDone = null;
    const b = this.bot;
    const g = this._targetGoal;
    if (!g) { this._recovering = false; return; }

    try { b.pathfinder.setGoal(null); } catch {}
    await new Promise(r => setTimeout(r, 100));

    await this._doStepRecoveryInternal();
  }

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

  async gotoNear(x, y, z, range = 2) {
    await this.stop();
    const sessionId = `gotoNear_${Date.now()}`;
    const goalDescriptor = makeGoalDescriptor('near', x, y, z, range);
    const session = createSession(sessionId, goalDescriptor, 15000);
    this._session = session;
    this._sessionGeneration++;

    // Reset fast stuck window
    this._resetFastStuckWindow();

    const goal = new goals.GoalNear(Math.floor(x), Math.floor(y), Math.floor(z), range);
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 15000));
    try {
      await Promise.race([this.bot.pathfinder.goto(goal), timeout]);
      session.state = SESSION_STATE.COMPLETE;
      return { ok: true, result: `Arrived near ${Math.round(x)}, ${Math.round(y)}, ${Math.round(z)}` };
    } catch (e) {
      const p = this.bot.entity.position;
      if (e.message === 'timeout') {
        session.state = SESSION_STATE.FAILED;
        return { ok: true, result: `Moved toward ${Math.round(x)},${Math.round(y)},${Math.round(z)}, now at ${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)}. Did not reach destination within timeout.` };
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
    // (goalDescriptor.type === 'follow' → just log, no physical recovery in Phase 1 stub).
    return { ok: true, result: `Following ${entity.username || entity.name || 'entity'}.` };
  }

  async stop() {
    const prevSession = this._session;
    this._session = null;
    this._sessionGeneration++;
    this._resetFastStuckWindow();

    if (prevSession) {
      prevSession.hardCancelled = true;
      prevSession.state = SESSION_STATE.CANCELLED;
    }

    // Legacy flags for compat with untouched recovery methods and Phase 0 tests
    this._active = false;
    this._recovering = false;
    this._targetGoal = null;
    this._stuckCount = 0;
    this._sameSpotCount = 0;

    try { this.bot.pathfinder.setGoal(null); } catch {}
    try { this.bot.stopDigging(); } catch {}
    try { this.bot.clearControlStates(); } catch {}
    this._clearControls();
  }

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
    // Import goals dynamically or use the module-level import
    let goal;
    if (goalDescriptor.type === 'block') {
      goal = new goals.GoalBlock(goalDescriptor.x, goalDescriptor.y, goalDescriptor.z);
    } else if (goalDescriptor.type === 'near') {
      goal = new goals.GoalNear(goalDescriptor.x, goalDescriptor.y, goalDescriptor.z, goalDescriptor.range || 2);
    } else if (goalDescriptor.type === 'follow') {
      return false; // cannot resume follow
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

  // Phase 1 stub: called from fast-stuck when STUCK_DETECTED.
  // Does NOT perform recovery (FSM comes in Phase 2). Just logs and marks session FAILED
  // so that navigation terminates cleanly instead of looping.
  _handleStuck(session) {
    if (!session) return;
    this._log(`stuck detected (session ${session.id}, state=${session.state}); Phase 1 stub: marking FAILED (no recovery yet)`);
    session.state = SESSION_STATE.FAILED;
    // Note: caller (interval) already set STUCK_DETECTED; we override to FAILED here for Phase 1.
    // In Phase 2 this will enqueue atomic recovery and only mark FAILED on unrecoverable.
  }

  dispose() {
    if (this._fastStuckInterval) {
      clearInterval(this._fastStuckInterval);
      this._fastStuckInterval = null;
    }
    this._session = null;
    this._active = false;
    this._recovering = false;
  }
}
