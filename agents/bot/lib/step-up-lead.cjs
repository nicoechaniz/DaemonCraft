/**
 * Step-up jump lead timing for mineflayer-pathfinder.
 *
 * Swept AABB yields ticksToContact = tEnter (ticks until the 0.6×0.6 box
 * touches the step block). A fixed leadTicks window is wrong because tEnter
 * scales with 1/v_dom on diagonals (velocity split across axes) while
 * cardinal motion keeps full speed on one axis — same tick count implies a
 * larger physical gap on cardinals.
 *
 * Correct invariant: fire when the gap along the *limiting* horizontal axis
 * is at most L (blocks), i.e.
 *
 *   ticksToContact * v_dom <= L
 *   leadTicks = L / v_dom
 *
 * where v_dom = max(|vx|, |vz|) per tick (the closing rate to the axis-aligned
 * face; see sweptAabb for why tEnter uses the max-constraining axis).
 * Equivalently leadTicks grows by ~sqrt(2) on 45° because v_dom halves while
 * |v| stays ~same.
 *
 * speedToward (velocity projected onto the step waypoint center) is only used
 * as a "moving toward step" gate (minSpeedToward), not for lead duration.
 *
 * The L + vDom model is correct for *physical gap at trigger*. The reason
 * pure cardinal 2→0 routes failed for any L (while 0→1 diag succeeded) was
 * not the formula — it was control starvation + node granularity in the
 * pathfinder integration (see the patch in node_modules/.../index.js and the
 * Y-SNAP + predict-jump blocks).
 */

const BOT_HALF_WIDTH = 0.3
/** Blocks along the limiting axis between AABB leading edge and step face at jump.
 * Cardinal needs ~0.42-0.5 (3.5-4.2 ticks at 0.118 b/t) to let y reach +1 *before or
 * during* the x-crossing of the bot half-width so the landing/support registers on
 * the higher surface rather than clipping the face and losing vx+vy. Diagonals
 * tolerate the value via corner geometry + split v. The model is sound; the
 * previous 0.36 was too tight for face-on + node granularity.
 */
const DEFAULT_LEAD_AXIS_GAP = 0.8
const MIN_LEAD_TICKS = 2
const MAX_LEAD_TICKS = 14
const VEL_EPS = 0.001

/**
 * Swept AABB vs step footprint [bx,bx+1]×[bz,bz+1]. Returns ticks until first
 * contact, or Infinity if not approaching / already past.
 */
function sweptAabbTicksToContact (px, pz, vx, vz, bx, bz, halfWidth = BOT_HALF_WIDTH) {
  const botMinX = px - halfWidth
  const botMaxX = px + halfWidth
  const botMinZ = pz - halfWidth
  const botMaxZ = pz + halfWidth
  let tEnter = 0
  let tExit = Infinity

  if (vx > VEL_EPS) {
    tEnter = Math.max(tEnter, (bx - botMaxX) / vx)
    tExit = Math.min(tExit, (bx + 1 - botMinX) / vx)
  } else if (vx < -VEL_EPS) {
    tEnter = Math.max(tEnter, (bx + 1 - botMinX) / vx)
    tExit = Math.min(tExit, (bx - botMaxX) / vx)
  } else if (botMinX >= bx + 1 || botMaxX <= bx) {
    tEnter = Infinity
  }

  if (vz > VEL_EPS) {
    tEnter = Math.max(tEnter, (bz - botMaxZ) / vz)
    tExit = Math.min(tExit, (bz + 1 - botMinZ) / vz)
  } else if (vz < -VEL_EPS) {
    tEnter = Math.max(tEnter, (bz + 1 - botMinZ) / vz)
    tExit = Math.min(tExit, (bz - botMaxZ) / vz)
  } else if (botMinZ >= bz + 1 || botMaxZ <= bz) {
    tEnter = Infinity
  }

  if (tEnter < tExit && tEnter >= 0) return tEnter
  return Infinity
}

/**
 * Adaptive lead window (ticks) from horizontal velocity and approach geometry.
 */
function computeStepUpLeadTicks (vx, vz, leadAxisGap = DEFAULT_LEAD_AXIS_GAP) {
  const vDom = Math.max(Math.abs(vx), Math.abs(vz))
  if (vDom < VEL_EPS) return MAX_LEAD_TICKS
  const raw = leadAxisGap / vDom
  return Math.min(MAX_LEAD_TICKS, Math.max(MIN_LEAD_TICKS, raw))
}

/**
 * Limiting-axis gap (blocks) if we jump when ticksToContact == tEnter.
 */
function axisGapAtContact (ticksToContact, vx, vz) {
  if (!Number.isFinite(ticksToContact)) return Infinity
  return ticksToContact * Math.max(Math.abs(vx), Math.abs(vz))
}

function evaluateStepUpJump ({
  px, pz, vx, vz, stepX, stepZ,
  leadAxisGap = DEFAULT_LEAD_AXIS_GAP,
  minSpeedToward = 0.02
}) {
  const bx = Math.floor(stepX)
  const bz = Math.floor(stepZ)
  const sdx = stepX - px
  const sdz = stepZ - pz
  const distToStep = Math.hypot(sdx, sdz)
  const dirX = distToStep > 0.0001 ? sdx / distToStep : 0
  const dirZ = distToStep > 0.0001 ? sdz / distToStep : 0
  const speedToward = (vx * dirX) + (vz * dirZ)
  const ticksToContact = sweptAabbTicksToContact(px, pz, vx, vz, bx, bz)
  const leadTicks = computeStepUpLeadTicks(vx, vz, leadAxisGap)
  const shouldJump = speedToward > minSpeedToward &&
    Number.isFinite(ticksToContact) &&
    ticksToContact <= leadTicks

  return {
    ticksToContact,
    leadTicks,
    speedToward,
    shouldJump,
    axisGapAtTrigger: axisGapAtContact(ticksToContact, vx, vz),
    vDom: Math.max(Math.abs(vx), Math.abs(vz))
  }
}

module.exports = {
  BOT_HALF_WIDTH,
  DEFAULT_LEAD_AXIS_GAP,
  sweptAabbTicksToContact,
  computeStepUpLeadTicks,
  axisGapAtContact,
  evaluateStepUpJump
}