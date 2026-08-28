/**
 * Decide whether an upward escape macro should stop because it reached the
 * surface.
 *
 * Human-directed recovery can disable this guard for open vertical shafts:
 * the shaft has sky visibility but still requires excavation to become
 * walkable.
 */
export function shouldStopAtOpenSky({ stopOnOpenSky = true, skyHeadroom, openCardinals }) {
  return stopOnOpenSky && skyHeadroom >= 96 && openCardinals >= 2;
}

/** Count only a stable block-level ascent, never a transient jump. */
export function hasVerticalProgress(fromY, toY) {
  return Math.floor(toY) > Math.floor(fromY);
}

const CARDINAL_YAW = Object.freeze({
  north: 0,
  south: Math.PI,
  east: -Math.PI / 2,
  west: Math.PI / 2,
});

/** Mineflayer direction convention: x=-sin(yaw), z=-cos(yaw). */
export function yawForCardinal(direction) {
  if (!(direction in CARDINAL_YAW)) throw new Error(`Unknown cardinal direction: ${direction}`);
  return CARDINAL_YAW[direction];
}