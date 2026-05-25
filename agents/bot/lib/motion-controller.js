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

export class MotionController {
  constructor(bot) {
    this.bot = bot;
    this._active = false;
    this._stuckCount = 0;
    this._recovering = false;
    this._targetGoal = null;
    
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

    // Fast stuck detection: every 500ms, if active and not moved >0.7m for 500ms, trigger.
    this._lastCheckPos = null;
    this._stuckCheckT0 = 0;
    this._fastStuckInterval = setInterval(() => {
      if (!this._active || this._recovering || !this.bot?.entity) return;
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
            this._recovering = true;  // claim before path_reset can
            if (blocked === 'forward') this._doMineRecovery();
            else if (blocked === 'left' || blocked === 'forward-left') this._doLateralRecovery('left');
            else if (blocked === 'right' || blocked === 'forward-right') this._doLateralRecovery('right');
            else this._doStepRecovery();
          }
        } else {
          this._stuckCheckT0 = 0;
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

  get isActive() { return this._active; }

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
    this._active = true;
    this._targetGoal = { x, y, z };
    const goal = new goals.GoalBlock(Math.floor(x), Math.floor(y), Math.floor(z));
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs));
    try {
      await Promise.race([this.bot.pathfinder.goto(goal), timeout]);
      return { ok: true, result: `Arrived at ${Math.round(x)}, ${Math.round(y)}, ${Math.round(z)}` };
    } catch (e) {
      const p = this.bot.entity.position;
      if (e.message === 'timeout' || (this._recovering && e.message.includes('goal was changed'))) {
        return { ok: true, result: `Walked toward ${Math.round(x)},${Math.round(y)},${Math.round(z)}, now at ${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)}.` };
      }
      return { ok: true, result: `Navigation failed: ${e.message}.` };
    } finally {
      if (!this._recovering) {
        this._active = false;
        try { this.bot.pathfinder.setGoal(null); } catch {}
      }
    }
  }

  async gotoNear(x, y, z, range = 2) {
    await this.stop();
    this._active = true;
    this._targetGoal = { x, y, z };
    const goal = new goals.GoalNear(Math.floor(x), Math.floor(y), Math.floor(z), range);
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 15000));
    try {
      await Promise.race([this.bot.pathfinder.goto(goal), timeout]);
      return { ok: true, result: `Arrived near ${Math.round(x)}, ${Math.round(y)}, ${Math.round(z)}` };
    } catch (e) {
      const p = this.bot.entity.position;
      if (e.message === 'timeout' || (this._recovering && e.message.includes('goal was changed'))) {
        return { ok: true, result: `Moved toward ${Math.round(x)},${Math.round(y)},${Math.round(z)}, now at ${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)}.` };
      }
      return { ok: true, result: `Navigation failed: ${e.message}.` };
    } finally {
      if (!this._recovering) {
        this._active = false;
        try { this.bot.pathfinder.setGoal(null); } catch {}
      }
    }
  }

  async follow(entity, distance = 2) {
    await this.stop();
    this._active = true;
    this.bot.pathfinder.setGoal(new goals.GoalFollow(entity, distance), true);
    return { ok: true, result: `Following ${entity.username || entity.name || 'entity'}.` };
  }

  async stop() {
    this._active = false;
    this._stuckCount = 0;
    this._sameSpotCount = 0;
    this._recovering = false;
    this._targetGoal = null;
    this._lastCheckPos = null;
    this._stuckCheckT0 = 0;
    try { this.bot.pathfinder.setGoal(null); } catch {}
    try { this.bot.stopDigging(); } catch {}
    try { this.bot.clearControlStates(); } catch {}
  }
}
