/**
 * MotionController — owns all bot.pathfinder state and provides safe navigation primitives.
 *
 * Stuck recovery: on 3 consecutive path_reset 'stuck' events, the controller
 * pauses the pathfinder, does a sprint-jump forward step, then re-sets the goal
 * so the pathfinder continues from the new position.
 */

import pathfinderPkg from 'mineflayer-pathfinder';
const { goals } = pathfinderPkg;

const FAST_STUCK_CHECK_INTERVAL_MS = 200;
const FAST_STUCK_MIN_PROGRESS_M = 0.5;
const FAST_STUCK_TRIGGER_MS = 200;
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
    this._teleportedAt = 0;  // suppress new goals for 2s after teleport
    this._recoveryEnabled = false; // recovery FSM disabled — stuck restarts use centering + goto/follow
    this._pendingGotoCleanup = null; // cleanup for active goto/gotoNear promise
    
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

  // Walk to the horizontal center of the block the bot is standing on.
  // Ensures the bot starts every movement with clearance from adjacent blocks.
  async _walkToBlockCenter(timeoutMs = 500) {
    const p = this.bot.entity.position;
    const cx = Math.floor(p.x) + 0.5;
    const cz = Math.floor(p.z) + 0.5;
    const dx = cx - p.x;
    const dz = cz - p.z;
    const dist = Math.sqrt(dx * dx + dz * dz);

    if (dist <= 0.1) return;

    this._log(`centering: (${p.x.toFixed(2)},${p.z.toFixed(2)}) → (${cx.toFixed(2)},${cz.toFixed(2)}) dist=${dist.toFixed(2)}`);

    this.bot.setControlState('forward', true);
    this.bot.setControlState('sprint', false);
    this.bot.setControlState('jump', false);

    const startPos = { x: p.x, z: p.z };
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      await new Promise(r => setTimeout(r, 100));
      const np = this.bot.entity.position;
      const ndx = cx - np.x;
      const ndz = cz - np.z;
      if (Math.abs(ndx) <= 0.1 && Math.abs(ndz) <= 0.1) {
        this._log('centering complete');
        break;
      }
      // Bail early if bot isn't making progress (stuck from start)
      const moved = Math.sqrt((np.x - startPos.x)**2 + (np.z - startPos.z)**2);
      if (moved < 0.05 && Date.now() - start > 300) {
        this._log('centering stalled — bailing');
        break;
      }
      this.bot.look(Math.atan2(-ndx, -ndz), 0);
    }

    this.bot.setControlState('forward', false);
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
    await this._walkToBlockCenter(); // center before starting path
    const sessionId = `goto_${Date.now()}`;
    const goalDescriptor = makeGoalDescriptor('block', x, y, z);
    const session = createSession(sessionId, goalDescriptor, timeoutMs);
    this._session = session;
    this._sessionGeneration++;

    // Reset fast stuck window
    this._resetFastStuckWindow();

    // Reject new goals within 2s of teleport — prevents flee/attack race
    const sinceTeleport = Date.now() - this._teleportedAt;
    if (sinceTeleport < 2000) {
      this._log(`goto rejected: ${sinceTeleport}ms since teleport`);
      return;
    }

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
    await this._walkToBlockCenter(); // center before starting path
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
    await this._walkToBlockCenter(); // center before starting follow
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

    this._stuckCount = 0;
    this._sameSpotCount = 0;

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

  /** Mark teleport — suppress new movement goals for 2s to prevent race with flee/attack. */
  markTeleported() {
    this._teleportedAt = Date.now();
    this._log('teleported — suppressing new goals for 2s');
  }

  /**
   * Phase 3: Called by BodyMutex._cancelCurrent for normal preemption.
   * Flags cancel; if mid-recovery, defers (lets atomic maneuver finish).
   */
  async requestMutexCancel(requester) {
    const session = this._session;
    if (!session) return;
    session.cancelRequested = true;

    if (session.state === SESSION_STATE.RECOVERY_ATOMIC) {
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

  // Phase 2: Recovery entry point — dispatches to deterministic FSM based on _classifyBlocked
  async _handleStuck(session) {
    if (!session || session.state !== SESSION_STATE.STUCK_DETECTED) return;
    if (session.hardCancelled || session.cancelRequested) return;
    if (!this._recoveryEnabled) {
      if (session.recoveryAttempt >= 3) {
        this._log(`stuck restart limit reached (${session.recoveryAttempt}) — giving up`);
        session.state = SESSION_STATE.FAILED;
        this._session = null;
        return;
      }
      session.recoveryAttempt++;
      session.state = SESSION_STATE.REPLANNING;
      this._log(`stuck detected (attempt ${session.recoveryAttempt}) — restarting via motion controller`);

      // If blocking block is easily mineable (leaves, dirt, etc.), mine it first
      const blocked = this._classifyBlocked();
      if (blocked && blocked !== 'unknown') {
        const p = this.bot.entity.position;
        const yaw = this.bot.entity.yaw;
        const fwdDx = -Math.sin(yaw), fwdDz = Math.cos(yaw);
        const mineBlock = this.bot.blockAt(p.offset(fwdDx, 1.5, fwdDz));
        if (mineBlock && mineBlock.name !== 'air' && mineBlock.name !== 'cave_air') {
          const easyBlocks = ['leaves', 'dirt', 'grass_block', 'sand', 'gravel', 'short_grass', 'tall_grass', 'fern', 'dead_bush', 'snow', 'vine', 'moss_carpet', 'bamboo'];
          if (easyBlocks.some(n => mineBlock.name.includes(n)) || mineBlock.hardness < 0.5) {
            this._log(`mining blocking block: ${mineBlock.name}`);
            try { await this.bot.dig(mineBlock, { forceLook: true }); } catch {}
          }
        }
      }

      // Restart through goto/follow so _walkToBlockCenter runs before the new path.
      const gd = session.goalDescriptor;
      if (gd && gd.type === 'block') {
        this.goto(gd.x, gd.y, gd.z);
      } else if (gd && gd.type === 'near') {
        this.gotoNear(gd.x, gd.y, gd.z, gd.range);
      } else if (gd && gd.type === 'follow' && gd.entity) {
        this.follow(gd.entity, gd.distance || 2);
      }
      return;
    }

    // ── Recovery FSM placeholder ──────────────────────────────────
    // If you ever need to re-enable recovery (backstep, rotate,
    // jump, measure), set this._recoveryEnabled = true and
    // re-add the FSM methods listed below.
    //
    // Required methods (currently stripped):
    //   _classifyBlocked()   — detect obstacle direction
    //   _doStepRecoveryFSM() — pause → sneak-back → jump-forward
    //   _doLateralRecoveryFSM() — strafe away from lateral obstacle
    //   _doMineRecoveryFSM() — mine the blocking block
    //   _pausePathfinder()   — temporarily disable pathfinder
    //   _resumeGoal()        — re-set goal after recovery
    //   _clearControls()     — release all movement control states
    //   _findNearestBodyBlock()
    //
    // See git history at ~2026-05-28 for the full implementation.
    // ──────────────────────────────────────────────────────────────
  }

  dispose() {
    if (this._fastStuckInterval) {
      clearInterval(this._fastStuckInterval);
      this._fastStuckInterval = null;
    }
    this._session = null;
  }
}
