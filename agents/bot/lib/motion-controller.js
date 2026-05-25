/**
 * MotionController — owns all bot.pathfinder state and provides safe navigation primitives.
 *
 * Stuck recovery: on 3 consecutive path_reset 'stuck' events, the controller
 * pauses the pathfinder, does a sprint-jump forward step, then re-sets the goal
 * so the pathfinder continues from the new position.
 */

import pathfinderPkg from 'mineflayer-pathfinder';
const { goals } = pathfinderPkg;

export class MotionController {
  constructor(bot) {
    this.bot = bot;
    this._active = false;
    this._stuckCount = 0;
    this._recovering = false;
    this._targetGoal = null;
    this._recoveryDone = null;  // resolve when recovery step completes
    this._lastStuckPos = null;  // track position for stuck-loop detection
    this._sameSpotCount = 0;    // consecutive recoveries in same spot

    bot.on('path_reset', (reason) => {
      if (reason === 'stuck' && this._active && !this._recovering) {
        this._stuckCount++;
        this._log(`stuck #${this._stuckCount}`);

        // Track if we're stuck in the same spot (position hasn't changed)
        const p = this.bot.entity.position;
        if (this._lastStuckPos) {
          const dx = p.x - this._lastStuckPos.x;
          const dy = p.y - this._lastStuckPos.y;
          const dz = p.z - this._lastStuckPos.z;
          const moved = Math.sqrt(dx*dx + dy*dy + dz*dz);
          if (moved < 0.5) {
            this._sameSpotCount++;
            this._log(`same spot #${this._sameSpotCount} (moved ${moved.toFixed(2)}m)`);
          } else {
            this._sameSpotCount = 0;
          }
        }
        this._lastStuckPos = { x: p.x, y: p.y, z: p.z };

        if (this._stuckCount >= 1) {
          if (this._sameSpotCount >= 2) {
            // Stuck-loop detected: mine the obstacle instead of dancing
            this._log('stuck-loop detected, mining obstacle...');
            this._doMineRecovery();
          } else {
            this._log('stuck threshold reached, recovery step...');
            this._doStepRecovery();
          }
        }
      }
    });
    bot.on('goal_reached', () => {
      this._stuckCount = 0;
      this._sameSpotCount = 0;
    });
  }

  _log(msg) {
    const ts = new Date().toISOString().slice(11, 23);
    console.error(`[${ts}] [motion] ${msg}`);
  }

  get isActive() { return this._active; }

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
    b.pathfinder.setGoal(new goals.GoalBlock(Math.floor(g.x), Math.floor(g.y), Math.floor(g.z)));
    this._log('recovery: done (step), pathfinder resumed');
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
      this._active = false;
      if (!this._recovering) {
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
      if (e.message === 'timeout') {
        return { ok: true, result: `Walked toward ${Math.round(x)},${Math.round(y)},${Math.round(z)} for 15s, now at ${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)}.` };
      }
      return { ok: true, result: `Navigation failed: ${e.message}.` };
    } finally {
      this._active = false;
      try { this.bot.pathfinder.setGoal(null); } catch {}
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
    try { this.bot.pathfinder.setGoal(null); } catch {}
    try { this.bot.stopDigging(); } catch {}
    try { this.bot.clearControlStates(); } catch {}
  }
}
