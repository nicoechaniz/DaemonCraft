#!/usr/bin/env python3
"""
Plan schema for DaemonCraft autonomous execution — Autonomía Corporal.

CONTRACT (Steve ↔ Gemma, per GePeTo review):
  - Steve (MiniMax $) owns: plans, verification predicates, exception handling,
    escalations, replanning. He is the strategic layer — expensive, deliberate,
    only woken when the autonomous loop cannot resolve a situation.
  - Gemma-Andy (Ollama $0) owns: execution of concrete intents via tool_calls,
    local world checks, bounded retries within a single step. She is the body
    — fast, local, disposable.
  - The autonomous loop (agent_loop.py / autonomous_loop.py) is the glue: it
    reads Steve's plan, feeds steps to Gemma, verifies results against Steve's
    predicates, advances or escalates. It is a finite-state machine, NOT an
    informal loop.

SAFETY PRINCIPLES (GePeTo):
  - Every step has a machine-checkable VerifySpec — no fuzzy "try and see".
  - Danger taxonomy is explicit (DangerLevel enum) — no vague "danger" keyword.
  - Finite-state controller: idle→executing→blocked→escalated→replanning→completed.
  - Retry with exponential backoff, escalation after threshold.
  - Confidence gate: if operational_risk high/critical from Gemma → escalate.
  - Structured JSON logging for every decision (replayable audit trail).
  - Type hints everywhere, Python 3.13+.

PLAN FILE:  workspace/plan.json  inside the per-agent workspace (~/agents/<name>/).
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field, asdict
from enum import Enum
from pathlib import Path
from typing import Any


# ═══════════════════════════════════════════════════════════════════════════════
# Enums — explicit taxonomies (GePeTo: "no vague keywords")
# ═══════════════════════════════════════════════════════════════════════════════

class PlanState(Enum):
    """Finite-state controller states for autonomous plan execution."""
    IDLE = "idle"
    EXECUTING = "executing"
    BLOCKED = "blocked"
    ESCALATED = "escalated"
    REPLANNING = "replanning"
    COMPLETED = "completed"
    CANCELLED = "cancelled"


class DangerLevel(Enum):
    """
    Explicit danger taxonomy per GePeTo review.
    When Gemma returns operational_risk matching any of these,
    the loop escalates to Steve immediately.
    """
    IRREVERSIBLE_ACTION = "irreversible_action"
    SECURITY_RISK = "security_risk"
    RESOURCE_EXHAUSTION = "resource_exhaustion"
    EXTERNAL_SIDE_EFFECTS = "external_side_effects"
    REPEATED_FAILURES = "repeated_failures"
    PLAN_CORRUPTION = "plan_corruption"

    @classmethod
    def parse_risk(cls, risk_str: str | None) -> DangerLevel | None:
        """Map Gemma's operational_risk string to DangerLevel enum."""
        if not risk_str:
            return None
        risk_lower = risk_str.lower().replace(" ", "_")
        for level in cls:
            if level.value == risk_lower:
                return level
        return None

    @property
    def is_critical(self) -> bool:
        """Critical dangers require IMMEDIATE escalation."""
        return self in (
            DangerLevel.IRREVERSIBLE_ACTION,
            DangerLevel.SECURITY_RISK,
            DangerLevel.PLAN_CORRUPTION,
        )


class VerifyType(Enum):
    """Machine-checkable verification predicates (GePeTo: "no fuzzy try-and-see")."""
    INVENTORY_HAS = "inventory_has"
    AREA_CLEAR = "area_clear"
    POSITION_REACHED = "position_reached"
    BLOCK_PLACED = "block_placed"
    ENTITY_NEARBY = "entity_nearby"


# ═══════════════════════════════════════════════════════════════════════════════
# Dataclasses — the data model
# ═══════════════════════════════════════════════════════════════════════════════

@dataclass
class VerifySpec:
    """
    Machine-checkable verification predicate for a plan step.

    Each type has its own parameter set. The verify() function in
    autonomous_loop.py reads this spec and compares against bot state
    fetched from the bot server API.
    """
    type: VerifyType

    # ── inventory_has ──
    item: str = ""                 # e.g. "oak_log"
    count: int = 0                # minimum count required

    # ── area_clear ──
    x1: int = 0
    z1: int = 0
    x2: int = 0
    z2: int = 0
    y: int = 64
    max_blocks_above: int = 0

    # ── position_reached ──
    target_x: int = 0
    target_y: int = 0
    target_z: int = 0
    max_distance: float = 3.0

    # ── block_placed ──
    block_x: int = 0
    block_y: int = 0
    block_z: int = 0
    block_material: str = ""

    # ── entity_nearby ──
    entity_type: str = ""
    entity_distance: float = 10.0

    def to_dict(self) -> dict[str, Any]:
        d = {"type": self.type.value}
        if self.type == VerifyType.INVENTORY_HAS:
            d.update(item=self.item, count=self.count)
        elif self.type == VerifyType.AREA_CLEAR:
            d.update(x1=self.x1, z1=self.z1, x2=self.x2, z2=self.z2,
                     y=self.y, max_blocks_above=self.max_blocks_above)
        elif self.type == VerifyType.POSITION_REACHED:
            d.update(target_x=self.target_x, target_y=self.target_y,
                     target_z=self.target_z, max_distance=self.max_distance)
        elif self.type == VerifyType.BLOCK_PLACED:
            d.update(block_x=self.block_x, block_y=self.block_y,
                     block_z=self.block_z, block_material=self.block_material)
        elif self.type == VerifyType.ENTITY_NEARBY:
            d.update(entity_type=self.entity_type, entity_distance=self.entity_distance)
        return d

    @classmethod
    def from_dict(cls, d: dict) -> VerifySpec:
        vtype = VerifyType(d["type"])
        return cls(
            type=vtype,
            item=d.get("item", ""),
            count=d.get("count", 0),
            x1=d.get("x1", 0),
            z1=d.get("z1", 0),
            x2=d.get("x2", 0),
            z2=d.get("z2", 0),
            y=d.get("y", 64),
            max_blocks_above=d.get("max_blocks_above", 0),
            target_x=d.get("target_x", 0),
            target_y=d.get("target_y", 0),
            target_z=d.get("target_z", 0),
            max_distance=d.get("max_distance", 3.0),
            block_x=d.get("block_x", 0),
            block_y=d.get("block_y", 0),
            block_z=d.get("block_z", 0),
            block_material=d.get("block_material", ""),
            entity_type=d.get("entity_type", ""),
            entity_distance=d.get("entity_distance", 10.0),
        )


@dataclass
class Step:
    """A single step in an autonomous plan — concrete, verifiable."""
    id: int
    intent: str                              # concrete intent for POST /intent
    verify: VerifySpec                       # machine-checkable success condition
    max_retries: int = 3
    retries: int = 0
    backoff_base: float = 2.0               # exponential backoff: base^retries seconds

    @property
    def exhausted(self) -> bool:
        return self.retries >= self.max_retries

    @property
    def next_backoff_seconds(self) -> float:
        return self.backoff_base ** self.retries


@dataclass
class Plan:
    """
    An autonomous execution plan owned by Steve, executed by Gemma.

    Written to workspace/plan.json inside the per-agent workspace.
    The autonomous loop reads it, advances step by step, and saves
    state after every transition.
    """
    goal: str
    steps: list[Step] = field(default_factory=list)
    current_step: int = 0
    state: PlanState = PlanState.IDLE
    started_at_ts: float = 0.0
    last_advance_ts: float = 0.0
    hard_timeout_s: int = 300               # 5 min without advance → escalate

    @property
    def current(self) -> Step | None:
        if 0 <= self.current_step < len(self.steps):
            return self.steps[self.current_step]
        return None

    @property
    def done(self) -> bool:
        return self.current_step >= len(self.steps)

    def timed_out(self, now: float) -> bool:
        if self.last_advance_ts == 0:
            return False
        return (now - self.last_advance_ts) > self.hard_timeout_s


# ═══════════════════════════════════════════════════════════════════════════════
# Serde (serialize/deserialize) — workspace/plan.json
# ═══════════════════════════════════════════════════════════════════════════════

def _plan_to_dict(plan: Plan) -> dict[str, Any]:
    return {
        "goal": plan.goal,
        "steps": [
            {
                "id": s.id,
                "intent": s.intent,
                "verify": s.verify.to_dict(),
                "max_retries": s.max_retries,
                "retries": s.retries,
                "backoff_base": s.backoff_base,
            }
            for s in plan.steps
        ],
        "current_step": plan.current_step,
        "state": plan.state.value,
        "started_at_ts": plan.started_at_ts,
        "last_advance_ts": plan.last_advance_ts,
        "hard_timeout_s": plan.hard_timeout_s,
    }


def _plan_from_dict(d: dict) -> Plan:
    return Plan(
        goal=d["goal"],
        steps=[
            Step(
                id=s["id"],
                intent=s["intent"],
                verify=VerifySpec.from_dict(s["verify"]),
                max_retries=s.get("max_retries", 3),
                retries=s.get("retries", 0),
                backoff_base=s.get("backoff_base", 2.0),
            )
            for s in d.get("steps", [])
        ],
        current_step=d.get("current_step", 0),
        state=PlanState(d.get("state", "idle")),
        started_at_ts=d.get("started_at_ts", 0.0),
        last_advance_ts=d.get("last_advance_ts", 0.0),
        hard_timeout_s=d.get("hard_timeout_s", 300),
    )


def load_plan(path: Path | str | None = None) -> Plan | None:
    """
    Load the active plan from workspace/plan.json.
    
    TEMPORARILY DISABLED: Plan execution is disabled while we stabilize
    single-shot intent execution. Plans caused infinite restart loops and
    blocked agents. Re-enable after body control is robust.
    """
    return None


def save_plan(plan: Plan, path: Path | str | None = None) -> bool:
    """
    Save the plan to workspace/plan.json atomically.
    
    TEMPORARILY DISABLED: Plan persistence is disabled while we stabilize
    single-shot intent execution. See load_plan() for context.
    """
    return False
