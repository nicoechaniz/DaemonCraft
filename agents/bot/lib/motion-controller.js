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

export const RECOVERY_STAGE = {
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
    this._activeRecovery = false;
    this._recoveryEnabled = false; // disabled for pathfinder debugging
    this._recoverySpinDir = 1; // alternates per recovery attempt (+1 / -1)
    this._pendingGotoCleanup = null; // cleanup for active goto/gotoNear promise
    this._recoveryPromise = null;
    
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

  _isSessionValid(session, generation) {
    return this._sessionGeneration === generation && !session.hardCancelled;
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

    // Tier 0: step check — solid at feet [0.4] forward BUT air at head [1.4] → step (1-block obstacle)
    const BODY_FEET = [0.4];
    const BODY_HEAD = [1.4];
    if (_isSolidAt(fwdDx, fwdDz, BODY_FEET) && !_isSolidAt(fwdDx, fwdDz, BODY_HEAD)) {
      return 'step';
    }

    // Tier 1: body-level blocks (0.4-1.9) — these need mine or strafe
    const BODY = [0.4, 0.9, 1.4, 1.9];
    if (_isSolidAt(fwdDx, fwdDz, BODY)) return 'forward';
    if (_isSolidAt(fwdLeftDx, fwdLeftDz, BODY)) return 'forward-left';
    if (_isSolidAt(fwdRightDx, fwdRightDz, BODY)) return 'forward-right';
    if (_isSolidAt(leftDx, leftDz, BODY)) return 'left';
    if (_isSolidAt(rightDx, rightDz, BODY)) return 'right';
    
    // Tier 2: nothing obvious — could be stuck on edge/lip, do backstep+jump (old step-at-[1] removed; now covered by Tier 0 or unknown)
    return 'unknown';
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
    this.bot.pathfinder.setGoal(goal);
    return new Promise((resolve) => {
      let timer;
      const onReached = () => {
        if (timer) clearTimeout(timer);
        this.bot.removeListener('goal_reached', onReached);
        this._pendingGotoCleanup = null;
        session.state = SESSION_STATE.COMPLETE;
        this._session = null;
        resolve({ ok: true, result: 'Arrived at ' + Math.round(x) + ', ' + Math.round(y) + ', ' + Math.round(z) });
      };
      const onTimeout = () => {
        this.bot.removeListener('goal_reached', onReached);
        this._pendingGotoCleanup = null;
        const p = this.bot.entity.position;
        session.state = SESSION_STATE.FAILED;
        this._session = null;
        resolve({ ok: true, result: 'Walked toward ' + Math.round(x) + ',' + Math.round(y) + ',' + Math.round(z) + ', now at ' + p.x.toFixed(1) + ',' + p.y.toFixed(1) + ',' + p.z.toFixed(1) + '. Did not reach destination within timeout.' });
      };
      timer = setTimeout(onTimeout, timeoutMs);
      this.bot.once('goal_reached', onReached);

      // Store cleanup for external cancellation (stop/mutexCancel/emergencyStop)
      this._pendingGotoCleanup = () => {
        if (timer) clearTimeout(timer);
        this.bot.removeListener('goal_reached', onReached);
        this._pendingGotoCleanup = null;
        session.state = SESSION_STATE.CANCELLED;
        this._session = null;
        resolve({ ok: true, result: 'Navigation cancelled.' });
      };
    });
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
    this.bot.pathfinder.setGoal(goal);
    return new Promise((resolve) => {
      let timer;
      const onReached = () => {
        if (timer) clearTimeout(timer);
        this.bot.removeListener('goal_reached', onReached);
        this._pendingGotoCleanup = null;
        session.state = SESSION_STATE.COMPLETE;
        this._session = null;
        resolve({ ok: true, result: 'Arrived near ' + Math.round(x) + ', ' + Math.round(y) + ', ' + Math.round(z) });
      };
      const onTimeout = () => {
        this.bot.removeListener('goal_reached', onReached);
        this._pendingGotoCleanup = null;
        const p = this.bot.entity.position;
        session.state = SESSION_STATE.FAILED;
        this._session = null;
        resolve({ ok: true, result: 'Moved toward ' + Math.round(x) + ',' + Math.round(y) + ',' + Math.round(z) + ', now at ' + p.x.toFixed(1) + ',' + p.y.toFixed(1) + ',' + p.z.toFixed(1) + '. Did not reach destination within timeout.' });
      };
      timer = setTimeout(onTimeout, 15000);
      this.bot.once('goal_reached', onReached);

      // Store cleanup for external cancellation (stop/mutexCancel/emergencyStop)
      this._pendingGotoCleanup = () => {
        if (timer) clearTimeout(timer);
        this.bot.removeListener('goal_reached', onReached);
        this._pendingGotoCleanup = null;
        session.state = SESSION_STATE.CANCELLED;
        this._session = null;
        resolve({ ok: true, result: 'Navigation cancelled.' });
      };
    });
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
    if (this._activeRecovery) {
      if (this._session) this._session.hardCancelled = true;
      await new Promise(function(r) { return setTimeout(r, 100); });
    }

    const prevSession = this._session;
    this._session = null;
    this._sessionGeneration++;
    this._resetFastStuckWindow();

    if (prevSession) {
      prevSession.hardCancelled = true;
      prevSession.state = SESSION_STATE.CANCELLED;
    }

    this._stuckCount = 0;
    this._sameSpotCount = 0;
    this._activeRecovery = false;

    // Resolve pending goto promise immediately (N1 fix)
    if (this._pendingGotoCleanup) {
      const cleanup = this._pendingGotoCleanup;
      this._pendingGotoCleanup = null;
      cleanup();
    }

    try { this.bot.pathfinder.setGoal(null); } catch {}
    try { this.bot.stopDigging(); } catch {}
    try { this.bot.clearControlStates(); } catch {}
    this._clearControls();
  }

  /**
   * Phase 3: Called by BodyMutex._cancelCurrent for normal preemption.
   * Flags cancel; if mid-recovery, defers (lets atomic maneuver finish).
   */
  async requestMutexCancel(requester) {
    const session = this._session;
    if (!session) return;
    session.cancelRequested = true;

    if (session.state === SESSION_STATE.RECOVERY_ATOMIC || this._activeRecovery) {
      this._log(`cancel requested by ${requester} during recovery — deferring`);
      return;
    }

    // Normal cancel path (not in atomic recovery)
    session.hardCancelled = true;

    // Resolve pending goto promise immediately (N1 fix)
    if (this._pendingGotoCleanup) {
      const cleanup = this._pendingGotoCleanup;
      this._pendingGotoCleanup = null;
      cleanup();
    }

    try { this.bot.pathfinder.setGoal(null); } catch {}
    this._clearControls();
  }

  /**
   * Phase 3: Called by BodyMutex.emergencyStop — hard stop even mid-recovery.
   */
  async requestEmergencyStop(requester) {
    if (this._session) {
      this._session.hardCancelled = true;
      this._session.state = SESSION_STATE.CANCELLED;
    }
    this._activeRecovery = false;
    this._recoveryPromise = null;

    // Resolve pending goto promise immediately (N1 fix)
    if (this._pendingGotoCleanup) {
      const cleanup = this._pendingGotoCleanup;
      this._pendingGotoCleanup = null;
      cleanup();
    }

    try { this.bot.pathfinder.setGoal(null); } catch {}
    this._clearControls();
    this._session = null;
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

  // Sample forward/left/right at body heights to find nearest solid obstruction.
  // Used by step recovery to decide rotation direction.
  _findNearestBodyBlock() {
    const b = this.bot;
    if (!b || !b.entity) return null;
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

  async _doStepRecoveryFSM(session, generation) {
    // Guard: bail if session/generation changed (new navigation started)
    if (this._sessionGeneration !== generation) return;
    if (!session || session.state !== SESSION_STATE.RECOVERY_ATOMIC) return;

    try {
      // Stage: PAUSING_PATHFINDER
      await this._pausePathfinder();
      if (!this._isSessionValid(session, generation)) { this._clearControls(); return; }

      // Stage: BACKSTEP (crouched 260ms)
      this.bot.setControlState('sneak', true);
      this.bot.setControlState('back', true);
      await new Promise(r => setTimeout(r, 260));
      if (!this._isSessionValid(session, generation)) { this._clearControls(); return; }
      this._clearControls();

      // Stage: ROTATING — prefer nearest body block, else alternate ±60° using recoverySpinDir
      const yaw = this.bot.entity.yaw;
      const bodyBlock = this._findNearestBodyBlock();
      let targetYaw;
      if (bodyBlock) {
        // Rotate away: use spin dir (will flip after)
        targetYaw = yaw + (this._recoverySpinDir * (Math.PI / 3));
      } else {
        // Alternate per attempt
        const alt = (session.recoveryAttempt % 2 === 0) ? 1 : -1;
        targetYaw = yaw + alt * (Math.PI / 3);
      }
      // Round to nearest 22.5° (PI/8)
      targetYaw = Math.round(targetYaw / (Math.PI / 8)) * (Math.PI / 8);
      await this.bot.look(targetYaw, 0, false);
      if (!this._isSessionValid(session, generation)) { this._clearControls(); return; }

      // Flip spin dir for next attempt
      this._recoverySpinDir = -this._recoverySpinDir;

      // Stage: JUMP_FORWARD — measure, 600ms jump+forward, settle 200ms
      const preJump = { x: this.bot.entity.position.x, y: this.bot.entity.position.y, z: this.bot.entity.position.z };
      this.bot.setControlState('jump', true);
      this.bot.setControlState('forward', true);
      await new Promise(r => setTimeout(r, 600));
      if (!this._isSessionValid(session, generation)) { this._clearControls(); return; }
      this._clearControls();
      await new Promise(r => setTimeout(r, 200)); // physics settle
      if (!this._isSessionValid(session, generation)) { this._clearControls(); return; }

      // Stage: MEASURING
      const postJump = this.bot.entity.position;
      const dx = postJump.x - preJump.x;
      const dy = postJump.y - preJump.y;
      const dz = postJump.z - preJump.z;
      const moved = Math.sqrt(dx * dx + dz * dz);
      this._log(`step recovery result: dx=${dx.toFixed(2)} dy=${dy.toFixed(2)} dz=${dz.toFixed(2)} moved=${moved.toFixed(2)}`);

      // Stage: RESUME or FAILED
      if (dy > 0.3 || moved > 1.0) {
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
    } catch (e) {
      this._log(`step recovery error: ${e.message}`);
      session.state = SESSION_STATE.FAILED;
    }
  }

  async _doLateralRecoveryFSM(session, generation, blockedDir) {
    if (this._sessionGeneration !== generation) return;
    if (!session || session.state !== SESSION_STATE.RECOVERY_ATOMIC) return;

    try {
      await this._pausePathfinder();
      if (!this._isSessionValid(session, generation)) { this._clearControls(); return; }

      // Compute obstacle world normal from blockedDir + current yaw
      const yaw = this.bot.entity.yaw;
      let obsDx, obsDz;
      if (blockedDir === 'left' || blockedDir === 'forward-left') {
        obsDx = -Math.cos(yaw);
        obsDz = -Math.sin(yaw);
      } else {
        obsDx = Math.cos(yaw);
        obsDz = Math.sin(yaw);
      }
      const len = Math.sqrt(obsDx * obsDx + obsDz * obsDz) || 1;
      const obsNx = obsDx / len;
      const obsNz = obsDz / len;

      // Stage: ROTATING_LATERAL — rotate away from obstacle by ~0.5 rad
      let targetYaw;
      if (blockedDir === 'left' || blockedDir === 'forward-left') {
        targetYaw = yaw + 0.5; // turn right
      } else {
        targetYaw = yaw - 0.5; // turn left
      }
      await this.bot.look(targetYaw, 0, false);
      if (!this._isSessionValid(session, generation)) { this._clearControls(); return; }
      await new Promise(r => setTimeout(r, 150)); // settle
      if (!this._isSessionValid(session, generation)) { this._clearControls(); return; }

      // Stage: MEASURING pre-strafe + reclassify
      const preStrafe = { x: this.bot.entity.position.x, y: this.bot.entity.position.y, z: this.bot.entity.position.z };
      const recheck = this._classifyBlocked();

      // Compute strafe dir: right vector dot obs normal; if positive, right points toward obs → strafe left (away)
      const newYaw = this.bot.entity.yaw;
      const rightDx = Math.cos(newYaw);
      const rightDz = Math.sin(newYaw);
      const dotRight = rightDx * obsNx + rightDz * obsNz;
      const strafeRight = dotRight < 0; // if dotRight <0, right points away → strafe right to move away? Wait: logic per spec: strafe away

      // Stage: STRAFE_AWAY (sneak + lateral)
      this.bot.setControlState('sneak', true);
      if (strafeRight) {
        this.bot.setControlState('right', true);
      } else {
        this.bot.setControlState('left', true);
      }
      await new Promise(r => setTimeout(r, LATERAL_STRAFE_MS));
      if (!this._isSessionValid(session, generation)) { this._clearControls(); return; }
      this._clearControls();
      await new Promise(r => setTimeout(r, 200));
      if (!this._isSessionValid(session, generation)) { this._clearControls(); return; }

      // Stage: separation measurement
      const postStrafe = this.bot.entity.position;
      const dispDx = postStrafe.x - preStrafe.x;
      const dispDz = postStrafe.z - preStrafe.z;
      const separation = dispDx * obsNx + dispDz * obsNz; // dot with obs normal; per spec: negative = moved away
      this._log(`lateral recovery: separation=${separation.toFixed(2)}`);

      const recheck2 = this._classifyBlocked();
      const stillBlocked = (recheck2 === 'left' || recheck2 === 'right' || recheck2 === 'forward-left' || recheck2 === 'forward-right');

      if (separation < -0.3 && !stillBlocked) {
        this._resetFastStuckWindow();
        if (session.goalDescriptor) {
          this._resumeGoal(session.goalDescriptor);
          session.state = SESSION_STATE.NAVIGATING;
        } else {
          session.state = SESSION_STATE.COMPLETE;
        }
        this._log('lateral recovery: resumed navigation');
      } else {
        this._log('lateral recovery: insufficient separation or still blocked, falling back to step');
        await this._doStepRecoveryFSM(session, generation);
      }
    } catch (e) {
      this._log(`lateral recovery error: ${e.message}`);
      session.state = SESSION_STATE.FAILED;
      // ensure fallback? but per spec, on error outer finally clears
    }
  }

  async _doMineRecoveryFSM(session, generation) {
    if (this._sessionGeneration !== generation) return;
    if (!session || session.state !== SESSION_STATE.RECOVERY_ATOMIC) return;

    try {
      await this._pausePathfinder();
      if (!this._isSessionValid(session, generation)) { this._clearControls(); return; }

      // Find block at bot face (+1.5 height)
      const b = this.bot;
      const facing = b.entity.position.offset(
        -Math.sin(b.entity.yaw), 1.5, Math.cos(b.entity.yaw)
      );
      const block = b.blockAt(facing);

      if (block && block.name !== 'air' && block.name !== 'cave_air' && block.name !== 'void_air' && b.canDigBlock(block)) {
        this._log(`recovery: mining ${block.name}`);
        try {
          await b.dig(block, true);
          this._log('recovery: mined successfully');
          this._resetFastStuckWindow();
          if (session.goalDescriptor) {
            this._resumeGoal(session.goalDescriptor);
            session.state = SESSION_STATE.NAVIGATING;
          }
          this._log('recovery: resumed after mining');
        } catch (e) {
          this._log(`recovery: dig failed (${e.message}), fallback to step`);
          await this._doStepRecoveryFSM(session, generation);
        }
      } else {
        this._log(`recovery: no mineable block, fallback to step`);
        await this._doStepRecoveryFSM(session, generation);
      }
    } catch (e) {
      this._log(`mine recovery error: ${e.message}`);
      session.state = SESSION_STATE.FAILED;
      await this._doStepRecoveryFSM(session, generation); // per spirit, but guard will catch gen
    }
  }

  // Phase 2: Recovery entry point — dispatches to deterministic FSM based on _classifyBlocked
  async _handleStuck(session) {
    if (!session || session.state !== SESSION_STATE.STUCK_DETECTED) return;
    if (session.hardCancelled || session.cancelRequested) return;
    if (!this._recoveryEnabled) {
      // Simple restart-on-stuck: replan from current position.
      // The new path triggers centering in monitorMovement, giving
      // the bot clearance from the obstacle it's stuck against.
      if (session.recoveryAttempt >= 3) {
        this._log(`stuck restart limit reached (${session.recoveryAttempt}) — giving up`);
        session.state = SESSION_STATE.FAILED;
        this._session = null;
        return;
      }
      session.recoveryAttempt++;
      this._log(`stuck detected (attempt ${session.recoveryAttempt}) — restarting navigation`);

      const gd = session.goalDescriptor;
      if (gd && gd.type !== 'follow') {
        this.bot.pathfinder.setGoal(null);
        setTimeout(() => {
          let goal;
          if (gd.type === 'block') {
            goal = new goals.GoalBlock(gd.x, gd.y, gd.z);
          } else if (gd.type === 'near') {
            goal = new goals.GoalNear(gd.x, gd.y, gd.z, gd.range);
          }
          if (goal) {
            this.bot.pathfinder.setGoal(goal);
            this._resetFastStuckWindow();
            session.state = SESSION_STATE.NAVIGATING;
            this._log('goal re-set after stuck restart');
          }
        }, 100);
      }
      return;
    }
    if (session.goalDescriptor && session.goalDescriptor.type === 'follow') {
      this._log('follow session, skipping recovery');
      return;
    }
    if (this._activeRecovery) return; // already recovering
    this._activeRecovery = true;
    const generation = this._sessionGeneration;

    this._recoveryPromise = Promise.resolve().then(async () => {
      try {
        session.state = SESSION_STATE.RECOVERY_ATOMIC;
        session.recoveryAttempt++;

        const blocked = this._classifyBlocked();
        this._log(`recovery attempt=${session.recoveryAttempt} direction=${blocked}`);

        if (blocked === 'step' || blocked === 'unknown') {
          await this._doStepRecoveryFSM(session, generation);
        } else if (blocked === 'left' || blocked === 'right' || blocked === 'forward-left' || blocked === 'forward-right') {
          await this._doLateralRecoveryFSM(session, generation, blocked);
        } else if (blocked === 'forward') {
          await this._doMineRecoveryFSM(session, generation);
        } else {
          await this._doStepRecoveryFSM(session, generation); // fallback
        }
      } catch (e) {
        this._log(`recovery error: ${e.message}`);
        session.state = SESSION_STATE.FAILED;
      } finally {
        if (session && session.cancelRequested && !session.hardCancelled) {
          session.hardCancelled = true;
          session.state = SESSION_STATE.CANCELLED;
          try { this.bot.pathfinder.setGoal(null); } catch (e) {}
          this._clearControls();
        }
        this._activeRecovery = false;
        this._clearControls();
        this._recoveryPromise = null;
      }
    });
    await this._recoveryPromise;
  }

  dispose() {
    if (this._fastStuckInterval) {
      clearInterval(this._fastStuckInterval);
      this._fastStuckInterval = null;
    }
    if (this._activeRecovery) {
      if (this._session) this._session.hardCancelled = true;
      // Schedule short yield for in-flight recovery guards to observe hardCancelled (dispose API remains sync)
      void new Promise(function(r) { return setTimeout(r, 100); });
    }
    this._session = null;
    this._activeRecovery = false;
    this._recoverySpinDir = 1;
    this._recoveryPromise = null;
  }
}
