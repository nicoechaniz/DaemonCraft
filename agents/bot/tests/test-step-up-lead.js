// Step-up lead timing: swept AABB + geometry-adaptive leadTicks.
// Run: node agents/bot/tests/test-step-up-lead.js

import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const {
  sweptAabbTicksToContact,
  computeStepUpLeadTicks,
  axisGapAtContact,
  evaluateStepUpJump,
  DEFAULT_LEAD_AXIS_GAP
} = require('../lib/step-up-lead.cjs')

let failed = 0

const test = (name, fn) => {
  try {
    fn()
    console.log(`  PASS: ${name}`)
  } catch (e) {
    console.error(`  FAIL: ${name}`)
    console.error(`    ${e.message}`)
    failed++
    process.exitCode = 1
  }
}

const approx = (a, b, eps = 0.05) => {
  if (Math.abs(a - b) > eps) throw new Error(`expected ~${b}, got ${a}`)
}

console.log('Running step-up lead timing tests...\n')

test('cardinal +X: tEnter matches slab distance / vx', () => {
  const px = 5.0
  const pz = 10.5
  const vx = 0.12
  const vz = 0
  const bx = 6
  const bz = 10
  const t = sweptAabbTicksToContact(px, pz, vx, vz, bx, bz)
  // botMaxX = 5.3, face at bx=6 → gap 0.7 → 0.7/0.12
  approx(t, 0.7 / 0.12)
})

test('diagonal 45°: tEnter is sqrt(2) times cardinal for symmetric setup', () => {
  const vx = 0.12 / Math.SQRT2
  const vz = 0.12 / Math.SQRT2
  const tCard = sweptAabbTicksToContact(5.0, 10.5, 0.12, 0, 6, 10)
  const tDiag = sweptAabbTicksToContact(5.0, 10.5, vx, vz, 6, 10)
  approx(tDiag / tCard, Math.SQRT2, 0.08)
})

test('leadTicks scales up on diagonal vs cardinal at same |v|', () => {
  const v = 0.12
  const leadCard = computeStepUpLeadTicks(v, 0)
  const leadDiag = computeStepUpLeadTicks(v / Math.SQRT2, v / Math.SQRT2)
  approx(leadDiag / leadCard, Math.SQRT2, 0.08)
  approx(leadCard, DEFAULT_LEAD_AXIS_GAP / v)
})

test('trigger keeps constant axis gap for cardinal and diagonal', () => {
  const evalCard = evaluateStepUpJump({
    px: 5.0, pz: 10.5, vx: 0.12, vz: 0, stepX: 6.5, stepZ: 10.5
  })
  // Position so tEnter == leadTicks (at threshold)
  const bx = 6
  const lead = computeStepUpLeadTicks(0.12, 0)
  const pxTrigger = bx - 0.3 - lead * 0.12
  const atThreshold = evaluateStepUpJump({
    px: pxTrigger, pz: 10.5, vx: 0.12, vz: 0, stepX: 6.5, stepZ: 10.5
  })
  approx(atThreshold.axisGapAtTrigger, DEFAULT_LEAD_AXIS_GAP, 0.06)
  approx(atThreshold.ticksToContact, lead, 0.15)

  const vx = 0.12 / Math.SQRT2
  const vz = 0.12 / Math.SQRT2
  const leadD = computeStepUpLeadTicks(vx, vz)
  const pxD = bx - 0.3 - leadD * vx
  const pzD = 10.0 - 0.3 - leadD * vz
  const atDiag = evaluateStepUpJump({
    px: pxD, pz: pzD, vx, vz, stepX: 6.5, stepZ: 10.5
  })
  approx(atDiag.axisGapAtTrigger, DEFAULT_LEAD_AXIS_GAP, 0.08)
})

test('fixed lead=10 jumps cardinal earlier than diagonal (regression)', () => {
  const gap = (ticks, vx, vz) => axisGapAtContact(ticks, vx, vz)
  const vx = 0.12 / Math.SQRT2
  const vz = 0.12 / Math.SQRT2
  const gapCardAt10 = gap(10, 0.12, 0)
  const gapDiagAt10 = gap(10, vx, vz)
  if (!(gapCardAt10 > gapDiagAt10)) {
    throw new Error(`cardinal gap ${gapCardAt10} should exceed diagonal ${gapDiagAt10} at lead=10`)
  }
})

test('adaptive lead: cardinal gap at threshold is in the 0.4-0.5 window that works with forward-protected rise (see step-up-lead.cjs)', () => {
  const lead = computeStepUpLeadTicks(0.12, 0)
  const gapAtLead = lead * 0.12
  if (gapAtLead > 0.55 || gapAtLead < 0.35) {
    throw new Error(`cardinal gap ${gapAtLead} outside expected ~0.45 for current L=${require('../lib/step-up-lead.cjs').DEFAULT_LEAD_AXIS_GAP}`)
  }
})

console.log(failed ? `\n${failed} failed` : '\nAll passed')