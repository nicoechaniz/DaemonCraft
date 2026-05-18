/**
 * MotionController — owns all bot.pathfinder state and provides safe navigation primitives.
 *
 * All pathfinding, goal setting, and movement cleanup is centralized here so server.js
 * never touches pathfinder directly for navigation.
 */

import pathfinderPkg from 'mineflayer-pathfinder';
const { goals } = pathfinderPkg;

export class MotionController {
  constructor(bot) {
    this.bot = bot;
    this._active = false;
  }

  get isActive() { return this._active; }

  async goto(x, y, z, timeoutMs = 15000) {
    await this.stop();
    this._active = true;
    const goal = new goals.GoalBlock(Math.floor(x), Math.floor(y), Math.floor(z));
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs));
    try {
      await Promise.race([this.bot.pathfinder.goto(goal), timeout]);
      return { ok: true, result: `Arrived at ${Math.round(x)}, ${Math.round(y)}, ${Math.round(z)}` };
    } catch (e) {
      const p = this.bot.entity.position;
      if (e.message === 'timeout') {
        return { ok: true, result: `Walked toward ${Math.round(x)},${Math.round(y)},${Math.round(z)} for ${timeoutMs/1000}s, now at ${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)}.` };
      }
      return { ok: true, result: `Navigation failed: ${e.message}.` };
    } finally {
      this._active = false;
      try { this.bot.pathfinder.setGoal(null); } catch {}
    }
  }

  async gotoNear(x, y, z, range = 2) {
    await this.stop();
    this._active = true;
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
    try { this.bot.pathfinder.setGoal(null); } catch {}
    try { this.bot.stopDigging(); } catch {}
    try { this.bot.clearControlStates(); } catch {}
  }
}
