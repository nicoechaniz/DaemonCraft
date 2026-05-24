/**
 * Action classification registry + abort contracts for BodyMutex.
 *
 * - tag: 'preemptible' (can yield) | 'atomic' (short uninterruptible window)
 * - safeYield: hint for _waitForSafeYield strategy (future use)
 * - maxMs: hard ceiling for atomic actions (used by claimCritical deadline)
 *
 * Unregistered actions default to 'preemptible'.
 */

export const ACTION_REGISTRY = {
  'goto':          { tag: 'preemptible', safeYield: 'on_ground', maxMs: null },
  'place_block':   { tag: 'atomic',      safeYield: null,         maxMs: 400 },
  'mine_block':    { tag: 'preemptible', safeYield: 'post_dig',   maxMs: null },
  'attack_entity': { tag: 'preemptible', safeYield: 'on_ground',  maxMs: null },
  'jump':          { tag: 'atomic',      safeYield: null,         maxMs: 300 },
  'use_item':      { tag: 'atomic',      safeYield: null,         maxMs: 200 },
  'eat':           { tag: 'atomic',      safeYield: null,         maxMs: 200 },
  'equip':         { tag: 'atomic',      safeYield: null,         maxMs: 100 },
};

/**
 * Small once() helper for event waits inside ON_ABORT handlers.
 */
function once(emitter, eventName) {
  return new Promise((resolve) => {
    if (!emitter || typeof emitter.once !== 'function') {
      return resolve();
    }
    emitter.once(eventName, resolve);
  });
}

/**
 * ON_ABORT cleanup contracts — called (future) by action wrapper on cancellation.
 * Keep these lightweight and defensive; they may run while bot is in motion.
 */
export const ON_ABORT = {
  'place_block': async (bot, ctx) => {
    const target = ctx && ctx.targetPos;
    if (!target || !bot || !bot.blockAt) return;
    const block = bot.blockAt(target);
    if (!block || block.name === 'air') {
      // Recover inventory state after failed/partial place
      if (typeof bot.syncInventory === 'function') {
        await bot.syncInventory();
      }
    }
  },

  'jump': async (bot, ctx) => {
    if (!bot || !bot.entity) return;
    if (!bot.entity.onGround) {
      try {
        bot.setControlState('sneak', true);
        await once(bot, 'move');
        bot.setControlState('sneak', false);
      } catch {
        // Best effort only
      }
    }
  },

  'mine_block': async (bot, ctx) => {
    if (!bot) return;
    try { bot.stopDigging(); } catch {}
    try { bot.setControlState('sneak', false); } catch {}
  },
};

// Default export for convenience in dynamic imports
export default { ACTION_REGISTRY, ON_ABORT };
