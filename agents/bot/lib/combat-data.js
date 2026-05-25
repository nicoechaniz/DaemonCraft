/**
 * Centralized entity and item lists — SINGLE SOURCE OF TRUTH.
 * Derived from minecraft-data where possible, curated for combat relevance.
 *
 * NEVER duplicate these lists inline. Always import from here.
 * To regenerate: node -e "const d=require('./lib/combat-data.js'); console.log(d.HOSTILE_NAMES)"
 */

// ── Hostile Entities ──────────────────────────────────────
// Aggressive hostiles only (excludes neutral mobs like iron_golem, snow_golem, allay)
export const HOSTILE_NAMES = [
  'blaze',
  'bogged',
  'breeze',
  'cave_spider',
  'creeper',
  'drowned',
  'elder_guardian',
  'ender_dragon',
  'enderman',
  'endermite',
  'evoker',
  'ghast',
  'guardian',
  'hoglin',
  'husk',
  'illusioner',
  'magma_cube',
  'phantom',
  'piglin',
  'piglin_brute',
  'pillager',
  'ravager',
  'shulker',
  'silverfish',
  'skeleton',
  'slime',
  'spider',
  'stray',
  'vex',
  'vindicator',
  'warden',
  'witch',
  'wither',
  'wither_skeleton',
  'zoglin',
  'zombie',
  'zombie_villager',
  'zombified_piglin',
];

// ── Weapons (best → worst) ────────────────────────────────
export const WEAPONS = [
  'netherite_sword', 'diamond_sword', 'iron_sword', 'stone_sword', 'wooden_sword',
  'netherite_axe', 'diamond_axe', 'iron_axe', 'stone_axe', 'wooden_axe',
  'trident', 'mace',
];

// ── Armor pieces ──────────────────────────────────────────
export const ARMOR_MATERIALS = ['netherite', 'diamond', 'iron', 'chainmail', 'golden', 'leather'];
export const ARMOR_SLOTS = ['helmet', 'chestplate', 'leggings', 'boots'];

// ── Harmful foods (auto-eat blacklist) ────────────────────
export const BANNED_FOOD = [
  'rotten_flesh', 'pufferfish', 'chorus_fruit', 'poisonous_potato', 'spider_eye',
];

// ── Helpers ───────────────────────────────────────────────

/** Check if an entity name matches a hostile type. Case-insensitive, substring-safe. */
export function isHostileName(name) {
  if (!name) return false;
  const n = name.toLowerCase();
  return HOSTILE_NAMES.some(h => n.includes(h));
}

/** Check if entity is a weapon based on its name. */
export function isWeaponName(name) {
  if (!name) return false;
  return WEAPONS.some(w => name.toLowerCase().includes(w));
}

/** Find best weapon in inventory and equip it. Returns true if equipped. */
export async function equipBestWeapon(bot) {
  for (const w of WEAPONS) {
    const item = bot.inventory.items().find(i => i.name === w);
    if (item) {
      await bot.equip(item, 'hand');
      return true;
    }
  }
  return false;
}

/** Check if inventory has any weapon. */
export function hasWeaponInInventory(bot) {
  return bot.inventory.items().some(i => isWeaponName(i.name));
}
