/**
 * MotionController — owns all bot.pathfinder state and provides safe navigation primitives.
 *
 * Stuck recovery: on 3 consecutive path_reset 'stuck' events, the controller
 * pauses the pathfinder, does a sprint-jump forward step, then re-sets the goal
 * so the pathfinder continues from the new position.
 */

import pathfinderPkg from 'mineflayer-pathfinder';
const { goals } = pathfinderPkg;

// ── Tunable constants ────────────────────────────────────────────
const MAX_STUCK_RECOVERY_ATTEMPTS = parseInt(process.env.MC_MAX_STUCK_ATTEMPTS || '10', 10);
// ──────────────────────────────────────────────────────────────────

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
    this._stuckRestartCount = 0;  // persists across session restarts — reset on new goto
    this._recoveryEnabled = true; // step/lateral/mine recovery FSM — re-enabled after pathfinder debug
    this._pendingGotoCleanup = null; // cleanup for active goto/gotoNear promise
    this._handlingStuck = false; // guard against re-entrant _handleStuck calls
    this._currentPath = []; // cached from mineflayer path_update events
    this._recoveryTargetKey = null; // step node being climbed, cleared on move
    
    bot.on('path_update', (results) => {
      if (results.path && results.path.length > 0) {
        this._currentPath = results.path;
      }
    });
    // Don't clear on goal_reached — path_update overwrites with fresh data.
    // Clearing breaks follows where goal_reached fires when bot is near player.
    bot.on('goal_reached', () => {
      // intentionally empty — cache lives across goal_reached
    });
    
    bot.on('goal_reached', () => {
      this._stuckCount = 0;
      this._sameSpotCount = 0;
      this._stuckRestartCount = 0;
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
            // Guard against re-entrant _handleStuck calls (async, fire-and-forget).
            // Without this, the 200ms interval fires a second _handleStuck while
            // the first is still mining — the second's goto restart cancels the first's dig.
            if (!this._handlingStuck) {
              this._handlingStuck = true;
              this._handleStuck(s).finally(() => { this._handlingStuck = false; });
            }
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
  // Tied to t_97b030a6 followup (2026-06-02): also ground the bot in Y
  // if it's floating (e.g. after a step-up that left it 0.4m above the
  // floor). A small jump breaks on_ground and re-engages gravity.
  async _walkToBlockCenter(timeoutMs = 500) {
    const p = this.bot.entity.position;
    this._log(`[DBG] _walkToBlockCenter START pos=(${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)}) onGround=${this.bot.entity.onGround} velocity=(${this.bot.entity.velocity.x.toFixed(2)},${this.bot.entity.velocity.y.toFixed(2)},${this.bot.entity.velocity.z.toFixed(2)})`);
    // Tied to t_97b030a6 followup (2026-06-02): ground-snap before any movement.
    // If the bot is floating more than 0.1m above an integer Y, nudge it down
    // by toggling jump (breaks onGround, gravity resumes, lands on floor).
    // Note: use bot.entity.onGround (camelCase, NOT isOnGround — undefined).
    if (this.bot.entity.onGround === false) {
      const floorY = Math.floor(p.y);
      if (p.y - floorY > 0.1) {
        this._log(`[DBG] floating detected: y=${p.y.toFixed(2)} floorY=${floorY} deltaY=${(p.y - floorY).toFixed(2)} — nudging down`);
        this.bot.setControlState('jump', true);
        await new Promise(r => setTimeout(r, 80));
        this.bot.setControlState('jump', false);
        await new Promise(r => setTimeout(r, 120));
        const np2 = this.bot.entity.position;
        this._log(`[DBG] after nudge: y=${np2.y.toFixed(2)} onGround=${this.bot.entity.onGround} velocityY=${this.bot.entity.velocity.y.toFixed(2)}`);
      } else {
        this._log(`[DBG] !onGround but deltaY=${(p.y - floorY).toFixed(2)} <= 0.1, NOT nudging`);
      }
    } else {
      this._log(`[DBG] on ground, no Y fix needed`);
    }
    const cx = Math.floor(p.x) + 0.5;
    const cz = Math.floor(p.z) + 0.5;
    const dx = cx - p.x;
    const dz = cz - p.z;
    const dist = Math.sqrt(dx * dx + dz * dz);

    if (dist <= 0.1) {
      this._log(`[DBG] centering SKIPPED — dist=${dist.toFixed(2)} <= 0.1, already centered`);
      return;
    }

    this._log(`centering: (${p.x.toFixed(2)},${p.z.toFixed(2)}) → (${cx.toFixed(2)},${cz.toFixed(2)}) dist=${dist.toFixed(2)}`);

    this.bot.setControlState('forward', true);
    this.bot.setControlState('sprint', false);
    this.bot.setControlState('jump', false);

    const startPos = { x: p.x, z: p.z };
    const start = Date.now();
    let lastNp = p;
    while (Date.now() - start < timeoutMs) {
      await new Promise(r => setTimeout(r, 100));
      const np = this.bot.entity.position;
      const ndx = cx - np.x;
      const ndz = cz - np.z;
      const moved = Math.sqrt((np.x - startPos.x)**2 + (np.z - startPos.z)**2);
      this._log(`[DBG] centering tick: pos=(${np.x.toFixed(2)},${np.y.toFixed(2)},${np.z.toFixed(2)}) offX=${ndx.toFixed(2)} offZ=${ndz.toFixed(2)} moved=${moved.toFixed(2)} onGround=${this.bot.entity.onGround}`);
      if (Math.abs(ndx) <= 0.1 && Math.abs(ndz) <= 0.1) {
        this._log('centering complete');
        break;
      }
      // Bail early if bot isn't making progress (stuck from start)
      if (moved < 0.05 && Date.now() - start > 300) {
        this._log(`[DBG] centering stalled — bailing at moved=${moved.toFixed(3)}`);
        break;
      }
      this.bot.look(Math.atan2(-ndx, -ndz), 0);
      lastNp = np;
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
    // Tier 0b: step check at y+1 — solid at [1.0] AND air at [2.0]
    // Catches steps when the bot is at the face (feet check misses the 1-block gap).
    if (_isSolidAt(fwdDx, fwdDz, [1.0]) && !_isSolidAt(fwdDx, fwdDz, [2.0])) {
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
    this._log(`[DBG] goto CALLED target=(${x},${y},${z}) timeoutMs=${timeoutMs}`);
    await this.stop();
    this._log(`[DBG] goto after stop, calling _walkToBlockCenter`);
    await this._walkToBlockCenter(); // center before starting path
    this._log(`[DBG] goto after walkToBlockCenter, setting goal`);
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

    this._stuckRestartCount = 0;  // new goal, reset stuck counter

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
        try { this.bot.pathfinder.setGoal(null); } catch {}
        const p = this.bot.entity.position;
        session.state = SESSION_STATE.FAILED;
        this._log(`[DBG] goto TIMEOUT for (${x},${y},${z}) — final pos=(${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)}) onGround=${this.bot.entity.onGround} velocityY=${this.bot.entity.velocity.y.toFixed(2)}`);
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
    this._stuckRestartCount = 0;  // new goal, reset stuck counter

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
        try { this.bot.pathfinder.setGoal(null); } catch {}
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
    this._stuckRestartCount = 0;  // new goal, reset stuck counter

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
    this._stuckRestartCount = 0;

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

    if (session.state === SESSION_STATE.RECOVERY_ATOMIC) {
      this._log(`cancel requested by ${requester} during recovery — deferring`);
      return;
    }

    // Normal cancel: stop movement but do NOT resolve the goto promise.
    // The goto should continue after the runner releases the mutex.
    // Only clear controls + stop pathfinder — let the goto timeout/complete naturally.
    session.cancelRequested = true;
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
    this._log(`[DBG] _handleStuck CALLED state=${session ? session.state : 'null'} cancelRequested=${session ? session.cancelRequested : 'n/a'} hardCancelled=${session ? session.hardCancelled : 'n/a'}`)
    if (!session || session.state !== SESSION_STATE.STUCK_DETECTED) return;
    if (session.hardCancelled || session.cancelRequested) return;
    if (!this._recoveryEnabled) {
      if (this._stuckRestartCount >= MAX_STUCK_RECOVERY_ATTEMPTS) {
        this._log(`stuck restart limit reached (${this._stuckRestartCount}/${MAX_STUCK_RECOVERY_ATTEMPTS}) — giving up`);
        session.state = SESSION_STATE.FAILED;
        this._session = null;
        try { this.bot.pathfinder.setGoal(null); } catch {}
        this._stuckRestartCount = 0;
        return;
      }
      this._stuckRestartCount++;
      session.state = SESSION_STATE.REPLANNING;
      this._log(`stuck detected (attempt ${this._stuckRestartCount}/${MAX_STUCK_RECOVERY_ATTEMPTS}) — restarting via motion controller`);

      // If blocking block is easily mineable (leaves, dirt, etc.), mine it first
      const blocked = this._classifyBlocked();
      if (blocked && blocked !== 'unknown' && blocked !== 'step') {
        // Compute direction vector for the blocked direction
        const p = this.bot.entity.position;
        const yaw = this.bot.entity.yaw;
        const fwdDx = -Math.sin(yaw), fwdDz = Math.cos(yaw);
        const leftDx = -Math.cos(yaw), leftDz = -Math.sin(yaw);
        const rightDx = Math.cos(yaw), rightDz = Math.sin(yaw);
        let dx = 0, dz = 0;
        if (blocked === 'forward') { dx = fwdDx; dz = fwdDz; }
        else if (blocked === 'left') { dx = leftDx; dz = leftDz; }
        else if (blocked === 'right') { dx = rightDx; dz = rightDz; }
        else if (blocked === 'forward-left') { dx = fwdDx + leftDx; dz = fwdDz + leftDz; }
        else if (blocked === 'forward-right') { dx = fwdDx + rightDx; dz = fwdDz + rightDz; }
        
        // Try mining at body heights (0.5 to 2.0) in the blocked direction
        const easyBlocks = ['leaves', 'dirt', 'grass_block', 'sand', 'gravel', 'short_grass',
          'tall_grass', 'fern', 'dead_bush', 'snow', 'vine', 'moss_carpet', 'bamboo',
          'oak_leaves', 'spruce_leaves', 'birch_leaves', 'jungle_leaves', 'acacia_leaves',
          'dark_oak_leaves', 'mangrove_leaves', 'cherry_leaves', 'azalea_leaves'];
        const heights = [0.5, 1.0, 1.5, 2.0];
        for (const h of heights) {
          const block = this.bot.blockAt(p.offset(dx, h, dz));
          if (block && block.name !== 'air' && block.name !== 'cave_air') {
            if (easyBlocks.some(n => block.name.includes(n)) || (block.hardness != null && block.hardness < 0.5)) {
              this._log(`mining blocking ${block.name} at height ${h} (${blocked})`);
              try { await this.bot.dig(block, { forceLook: true }); break; } catch {}
            }
          }
        }
      }

      // Restart through goto/follow so _walkToBlockCenter runs before the new path.
      // Save stuck counter before goto/gotoNear/follow reset it to 0.
      // Random yaw jitter: prevents exact repetition loops on step-ups and narrow paths.
      this.bot.look(this.bot.entity.yaw + (Math.random() - 0.5) * 1.0, 0, true);
      const savedStuckCount = this._stuckRestartCount;
      const gd = session.goalDescriptor;
      if (gd && gd.type === 'block') {
        this.goto(gd.x, gd.y, gd.z);
      } else if (gd && gd.type === 'near') {
        this.gotoNear(gd.x, gd.y, gd.z, gd.range);
      } else if (gd && gd.type === 'follow' && gd.entity) {
        this.follow(gd.entity, gd.distance || 2);
      }
      this._stuckRestartCount = savedStuckCount;  // restore after goto's synchronous reset
      return;
    }

    // ── Recovery FSM (step only) ──────────────────────────────────
    // Check path BEFORE entering the FSM — no step means just restart goal
    const _floorY = Math.floor(this.bot.entity.position.y);
    const _hasStepInPath = this._currentPath.some(pt => pt && pt.y > _floorY);
    if (!_hasStepInPath) {
      this._log(`recovery: no step in path (len=${this._currentPath.length}), restarting goal`);
      session.state = SESSION_STATE.NAVIGATING;
      this._lastCheckPos = null;
      this._stuckCheckT0 = 0;
      if (session.goalDescriptor && session.goalDescriptor.type === 'follow' && session.goalDescriptor.entity) {
        this.bot.pathfinder.setGoal(new goals.GoalFollow(session.goalDescriptor.entity, session.goalDescriptor.distance || 2), true);
      } else if (session.goalDescriptor) {
        this._resumeGoal(session.goalDescriptor);
      }
      return;
    }

    if (this._activeRecovery) return;
    this._activeRecovery = true;
    const generation = this._sessionGeneration;

    this._recoveryPromise = Promise.resolve().then(async () => {
      try {
        session.state = SESSION_STATE.RECOVERY_ATOMIC;
        session.recoveryAttempt++;
        if (session.recoveryAttempt > 10) {
          this._log(`recovery attempt limit reached — giving up`);
          session.state = SESSION_STATE.FAILED;
          this._session = null;
          return;
        }
        this._log(`recovery attempt=${session.recoveryAttempt} hasStepInPath=true pathLen=${this._currentPath.length}`);
        await this._doStepRecoveryFSM(session, generation);
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
    // ──────────────────────────────────────────────────────────────
  }

  // Execute control sequence with guaranteed cleanup
  async _withControls(fn) {
    try { await fn(); } finally { this._clearControls(); }
  }

  // Sample forward/left/right at body heights to find nearest solid obstruction.
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
    let nearest = null, nearestDist = Infinity;
    for (const dir of dirs) {
      for (const h of BODY) {
        const pt = pos.offset(dir.dx, h, dir.dz);
        const blk = b.blockAt(pt);
        if (blk && blk.name !== 'air' && blk.name !== 'cave_air' && blk.name !== 'void_air' && blk.boundingBox === 'block') {
          const dist = Math.abs(dir.dx) + Math.abs(dir.dz);
          if (dist < nearestDist) { nearestDist = dist; nearest = { block: blk, direction: dir.name }; }
        }
      }
    }
    return nearest;
  }

  // Pause pathfinder (clear goal but don't change session state)
  async _pausePathfinder() {
    try { this.bot.pathfinder.setGoal(null); } catch {}
    await new Promise(r => setTimeout(r, 100));
  }

  // Resume original goal from a goal descriptor
  _resumeGoal(goalDescriptor) {
    if (!goalDescriptor || !goalDescriptor.type) return false;
    let goal;
    if (goalDescriptor.type === 'block') {
      goal = new goals.GoalBlock(goalDescriptor.x, goalDescriptor.y, goalDescriptor.z);
    } else if (goalDescriptor.type === 'near') {
      goal = new goals.GoalNear(goalDescriptor.x, goalDescriptor.y, goalDescriptor.z, goalDescriptor.range || 2);
    } else if (goalDescriptor.type === 'follow') {
      return false;
    }
    if (goal) { this.bot.pathfinder.setGoal(goal); return true; }
    return false;
  }

  async _doStepRecoveryFSM(session, generation) {
    if (this._sessionGeneration !== generation) return;
    if (!session || session.state !== SESSION_STATE.RECOVERY_ATOMIC) return;
    try {
      // Capture the step-up node we're trying to climb so we can detect
      // if the player moved between attempts
      const _floorY = Math.floor(this.bot.entity.position.y);
      const _stepNode = this._currentPath.find(pt => pt && pt.y > _floorY);
      const _stepKey = _stepNode ? `${_stepNode.x},${_stepNode.y},${_stepNode.z}` : null;
      if (!this._recoveryTargetKey) {
        this._recoveryTargetKey = _stepKey;
      } else if (this._recoveryTargetKey !== _stepKey) {
        this._log(`step recovery: step changed (player moved), aborting`);
        this._recoveryTargetKey = null;
        session.state = SESSION_STATE.NAVIGATING;
        if (session.goalDescriptor && session.goalDescriptor.type === 'follow' && session.goalDescriptor.entity) {
          this.bot.pathfinder.setGoal(new goals.GoalFollow(session.goalDescriptor.entity, session.goalDescriptor.distance || 2), true);
        }
        session.recoveryAttempt = 0;
        return;
      }
      await this._pausePathfinder();
      if (!this._isSessionValid(session, generation)) { this._clearControls(); return; }
      // BACKSTEP (crouched 260ms)
      this.bot.setControlState('sneak', true);
      this.bot.setControlState('back', true);
      await new Promise(r => setTimeout(r, 260));
      if (!this._isSessionValid(session, generation)) { this._clearControls(); return; }
      this._clearControls();
      // Small random yaw between attempts so each recovery is slightly different
      const _jitterYaw = this.bot.entity.yaw + (Math.random() - 0.5) * 0.6;
      await this.bot.look(_jitterYaw, 0);
      // JUMP_FORWARD (600ms)
      const preJump = { x: this.bot.entity.position.x, y: this.bot.entity.position.y, z: this.bot.entity.position.z };
      this.bot.setControlState('jump', true);
      this.bot.setControlState('forward', true);
      await new Promise(r => setTimeout(r, 600));
      if (!this._isSessionValid(session, generation)) { this._clearControls(); return; }
      this._clearControls();
      await new Promise(r => setTimeout(r, 200));
      if (!this._isSessionValid(session, generation)) { this._clearControls(); return; }
      // MEASURING
      const postJump = this.bot.entity.position;
      const dx = postJump.x - preJump.x, dy = postJump.y - preJump.y, dz = postJump.z - preJump.z;
      const moved = Math.sqrt(dx * dx + dz * dz);
      this._log(`step recovery: dx=${dx.toFixed(2)} dy=${dy.toFixed(2)} dz=${dz.toFixed(2)} moved=${moved.toFixed(2)}`);
      if (dy > 0.3 || moved > 1.0) {
        this._resetFastStuckWindow();
        if (session.goalDescriptor) {
          const resumed = this._resumeGoal(session.goalDescriptor);
          if (resumed) {
            session.state = SESSION_STATE.NAVIGATING;
          } else if (session.goalDescriptor.type === 'follow' && session.goalDescriptor.entity) {
            this.bot.pathfinder.setGoal(new goals.GoalFollow(session.goalDescriptor.entity, session.goalDescriptor.distance || 2), true);
            session.state = SESSION_STATE.NAVIGATING;
          } else {
            session.state = SESSION_STATE.COMPLETE;
          }
        } else {
          session.state = SESSION_STATE.COMPLETE;
        }
        session.recoveryAttempt = 0; // reset after successful recovery
        this._recoveryTargetKey = null;
        this._log('step recovery: resumed navigation');
      } else {
        this._log('step recovery: no progress, keeping NAVIGATING');
        session.state = SESSION_STATE.NAVIGATING;
        session.recoveryAttempt = 0; // reset so bot can keep trying
      }
    } catch (e) {
      this._log(`step recovery error: ${e.message}`);
      session.state = SESSION_STATE.NAVIGATING;
      session.recoveryAttempt = 0;
    }
  }

  dispose() {
    if (this._fastStuckInterval) {
      clearInterval(this._fastStuckInterval);
      this._fastStuckInterval = null;
    }
    this._session = null;
  }
}
