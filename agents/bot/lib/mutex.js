/**
 * BodyMutex — Phase 1 Reactive Runner body ownership arbitration.
 *
 * 4 CONTROL_MODE states for preemption between goal-driven (Gemma/Steve)
 * and reflex-driven (RunnerThread) behaviors.
 */

const CONTROL_MODE = {
  IDLE: 0,
  GOAL: 1,          // Goal layer (agent_loop / embodied) owns body
  REFLEX: 2,        // Runner (reflex) owns body — critical priority
  REFLEX_YIELD: 3,  // Runner requested yield; waiting for safe handoff point
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class BodyMutex {
  constructor(bot) {
    this.bot = bot;
    this.mode = CONTROL_MODE.IDLE;
    this.owner = null;
    this.since = Date.now();
    this.actionTag = null;
    this.atomicDeadline = 0;
  }

  async claimCritical(requester, actionTag, maxMs) {
    // Idempotent re-claim by same reflex owner
    if (this.mode === CONTROL_MODE.REFLEX && this.owner === requester) {
      return { allowed: true };
    }
    // Block if atomic action still within its deadline
    if (this.actionTag === 'atomic' && Date.now() < this.atomicDeadline) {
      return {
        allowed: false,
        reason: 'atomic_in_progress',
        deadline: this.atomicDeadline,
      };
    }
    await this._cancelCurrent();
    this.mode = CONTROL_MODE.REFLEX;
    this.owner = requester;
    this.actionTag = actionTag || null;
    this.since = Date.now();
    this.atomicDeadline = maxMs ? Date.now() + maxMs : 0;
    return { allowed: true };
  }

  async claimYield(requester) {
    if (this.mode === CONTROL_MODE.IDLE) {
      this.mode = CONTROL_MODE.REFLEX;
      this.owner = requester;
      this.since = Date.now();
      this.actionTag = null;
      this.atomicDeadline = 0;
      return { allowed: true, immediate: true };
    }
    if (this.mode === CONTROL_MODE.GOAL && this.actionTag === 'preemptible') {
      this.mode = CONTROL_MODE.REFLEX_YIELD;
      this.owner = requester;
      this.since = Date.now();
      await this._waitForSafeYield();
      this.mode = CONTROL_MODE.REFLEX;
      this.actionTag = null;
      this.atomicDeadline = 0;
      return { allowed: true, immediate: false };
    }
    return { allowed: false, reason: 'owner_busy' };
  }

  async release(requester) {
    if (this.owner !== requester) return false;
    const prevMode = this.mode;
    this.mode = CONTROL_MODE.IDLE;
    this.owner = null;
    this.actionTag = null;
    this.since = Date.now();
    this.atomicDeadline = 0;
    if (prevMode === CONTROL_MODE.REFLEX && this.bot && typeof this.bot.emit === 'function') {
      this.bot.emit('mutex_released', { to: 'goal' });
    }
    return true;
  }

  async emergencyStop(requester) {
    // Hard reset — bypass owner checks, any caller allowed
    const previous = { mode: this.mode, owner: this.owner };
    await this._cancelCurrent();
    this.mode = CONTROL_MODE.IDLE;
    this.owner = null;
    this.actionTag = null;
    this.since = Date.now();
    this.atomicDeadline = 0;
    if (this.bot && typeof this.bot.emit === 'function') {
      this.bot.emit('emergency_stopped', { by: requester, previous });
    }
    return { ok: true, previousMode: previous.mode, previousOwner: previous.owner };
  }

  async _cancelCurrent() {
    if (!this.bot) return;
    try { this.bot.pathfinder.stop(); } catch {}
    try { this.bot.clearControlStates(); } catch {}
    // TODO: plugin-specific cleanup (mining, placing, inventory windows, auto-eat, etc.)
    // Future: if (this.bot.collectBlock) ... ; if (this.bot.tool) ...
  }

  async _waitForSafeYield() {
    if (!this.bot || !this.bot.entity) return;
    const start = Date.now();
    const MAX_MS = 200;
    while (Date.now() - start < MAX_MS) {
      const onGround = !!this.bot.entity.onGround;
      const moving = this.bot.pathfinder && typeof this.bot.pathfinder.isMoving === 'function'
        ? this.bot.pathfinder.isMoving()
        : false;
      if (onGround && !moving) return;
      await sleep(10);
    }
    // Timeout: force cancel to guarantee handoff
    await this._cancelCurrent();
  }

  // Convenience for /mutex/status
  getStatus() {
    return {
      mode: this.mode,
      owner: this.owner,
      sinceMs: this.since ? Date.now() - this.since : 0,
      actionTag: this.actionTag,
      atomicDeadline: this.atomicDeadline,
    };
  }
}

export { CONTROL_MODE };
