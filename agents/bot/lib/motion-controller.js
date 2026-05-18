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

    bot.on('path_reset', (reason) => {
      if (reason === 'stuck' && this._active && !this._recovering) {
        this._stuckCount++;
        this._log(`stuck #${this._stuckCount}`);
        if (this._stuckCount >= 1) {
          this._log('stuck threshold reached, recovery step...');
          this._doStepRecovery();
        }
      }
    });
    bot.on('goal_reached', () => {
      this._stuckCount = 0;
    });
  }

  _log(msg) {
    const ts = new Date().toISOString().slice(11, 23);
    console.error(`[${ts}] [motion] ${msg}`);
  }

  get isActive() { return this._active; }

  async _doStepRecovery() {
    this._recovering = true;
    this._recoveryDone = null;
    const b = this.bot;
    const g = this._targetGoal;
    if (!g) { this._recovering = false; return; }

    // Clear pathfinder to take control
    try { b.pathfinder.setGoal(null); } catch {}
    await new Promise(r => setTimeout(r, 100));

    // Tiny backstep with sneak so we don't slide far
    this._log('recovery: backstep (crouched)');
    b.setControlState('sneak', true);
    b.setControlState('back', true);
    await new Promise(r => setTimeout(r, 200));
    b.setControlState('back', false);
    b.setControlState('sneak', false);

    // Jump forward
    this._log('recovery: jump forward');
    b.setControlState('forward', true);
    b.setControlState('jump', true);
    await new Promise(r => setTimeout(r, 600));
    b.setControlState('jump', false);
    b.setControlState('forward', false);

    // Hand back to pathfinder
    this._stuckCount = 0;
    this._active = true;  // keep alive so stuck detection works on new goal
    b.pathfinder.setGoal(new goals.GoalBlock(Math.floor(g.x), Math.floor(g.y), Math.floor(g.z)));
    this._log('recovery: done, pathfinder resumed');
    this._recovering = false;
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
    this._recovering = false;
    this._targetGoal = null;
    try { this.bot.pathfinder.setGoal(null); } catch {}
    try { this.bot.stopDigging(); } catch {}
    try { this.bot.clearControlStates(); } catch {}
  }
}
