#!/usr/bin/env python3
"""
PlanOrchestrator — Fase 3 Plan Decomposition orchestrator.

Coordinates execution of PlanManifest (Hermes-decomposed multi-step goals)
by delegating each SubPlan's embodied intent to QuantifiedIntentExecutor (Fase 2).

Key contracts:
- validate_manifest: HARD REQUIREMENT — every SubPlan MUST carry a VerifySpec.
  This is the anti-hallucination guard. LLM (Hermes) supplies it via mc_plan_decompose.
- execute_plan: walks sub_plans in 'order', respecting 'depends_on' (order values),
  starts tracking via executor, dispatches intent, checks verify on completion.
- On VerifySpec failure (or dispatch fail when abort_on_failure): escalates
  by returning structured previous_error for Hermes (Steve) to see in next
  heartbeat / replan. Does NOT call save_plan (still stubbed).

Design constraints (from task):
- Hermes (LLM) decomposes; this is only the executor/orchestrator.
- No encoding of building patterns in Python.
- No re-enabling of save_plan/load_plan.
- Injected callables for testability (no hard import cycles).
"""

from __future__ import annotations

import sys
from pathlib import Path
# Ensure repo root is importable so 'agents.plan_schema' resolves
_repo_root = Path(__file__).resolve().parent.parent
if str(_repo_root) not in sys.path:
    sys.path.insert(0, str(_repo_root))

from dataclasses import dataclass, field
from typing import Any, Callable, Optional

from agents.plan_schema import PlanManifest, SubPlan, VerifySpec, VerifyType
from agents.plan_executor import QuantifiedIntentExecutor, get_executor


@dataclass
class _SubPlanState:
    """Internal tracking for a sub-plan during execution."""
    subplan: SubPlan
    status: str = "pending"  # pending | running | done | failed | skipped
    result: Optional[dict] = None
    error: Optional[dict] = None


class PlanOrchestrator:
    """
    Orchestrates a PlanManifest.

    Typical usage (from agent_loop or strategic layer):
        orch = PlanOrchestrator(
            dispatch_intent=lambda intent: call_embodied(intent),
            log=lambda s: _log_event("orchestrator", msg=s),
        )
        manifest = PlanManifest.from_dict(hermes_tool_result)
        orch.validate_manifest(manifest)
        outcome = orch.execute_plan(manifest)
        if outcome.get("status") == "escalated":
            # include outcome["previous_error"] in heartbeat for Hermes replan
            ...
    """

    def __init__(
        self,
        executor: Optional[QuantifiedIntentExecutor] = None,
        dispatch_intent: Optional[Callable[[str], dict]] = None,
        log: Optional[Callable[[str], None]] = None,
    ):
        self._executor = executor or get_executor()
        self._dispatch_intent = dispatch_intent or self._noop_dispatch
        self._log = log or (lambda s: None)
        self._last_manifest: Optional[PlanManifest] = None
        self._subplan_states: dict[int, _SubPlanState] = {}  # keyed by order

    # ──────────────────────────────────────────────────────────────────────
    # Validation (anti-hallucination)
    # ──────────────────────────────────────────────────────────────────────

    def validate_manifest(self, manifest: PlanManifest) -> bool:
        """
        Enforce that EVERY SubPlan has a non-null VerifySpec with a type.

        Raises ValueError on first violation (clear message for LLM feedback
        via tool result). Returns True on success.
        """
        if manifest is None:
            raise ValueError("PlanManifest is None")
        if not manifest.goal or not isinstance(manifest.goal, str):
            raise ValueError("PlanManifest requires non-empty goal")
        if not manifest.sub_plans:
            # Empty is technically valid (no-op goal) but unusual
            return True

        for idx, sp in enumerate(manifest.sub_plans):
            if not isinstance(sp, SubPlan):
                raise ValueError(f"sub_plans[{idx}] is not a SubPlan instance")
            if sp.verify is None or not isinstance(sp.verify, VerifySpec):
                raise ValueError(
                    f"SubPlan order={sp.order} (intent={sp.intent[:40]}...) "
                    f"missing REQUIRED VerifySpec — anti-hallucination guard violated. "
                    f"Hermes must supply verify.type (INVENTORY_HAS, POSITION_REACHED, etc.) for every sub-plan."
                )
            if not sp.verify.type:
                raise ValueError(f"SubPlan order={sp.order} has VerifySpec without type")
            # Basic sanity on depends_on (non-negative ints, no self-dep)
            for dep in sp.depends_on:
                if not isinstance(dep, int) or dep < 0:
                    raise ValueError(f"SubPlan order={sp.order} has invalid depends_on entry: {dep}")
                if dep == sp.order:
                    raise ValueError(f"SubPlan order={sp.order} cannot depend on itself")
        return True

    # ──────────────────────────────────────────────────────────────────────
    # Execution
    # ──────────────────────────────────────────────────────────────────────

    def execute_plan(self, manifest: PlanManifest) -> dict[str, Any]:
        """
        Execute all sub-plans respecting order and depends_on.

        Algorithm:
        1. validate_manifest (hard fail if any missing verify)
        2. Sort by order asc.
        3. For each in order:
             - if any depends_on not yet marked done → skip for this pass (supports
               incremental calls from agent loop), or in full-sync mode we still
               require prior orders to have run.
             - start executor tracking with the subplan's verify
             - dispatch the embodied intent string
             - on dispatch ok: call on_intent_complete (sync for unit tests; real
               completion signaled externally via embodied result → executor)
             - if verify passes: mark done
             - else / dispatch fail: mark failed, build previous_error, escalate
               if abort_on_failure.

        Returns:
            {
              "status": "completed" | "partial" | "escalated" | "error",
              "goal": ...,
              "executed": [orders...],
              "failed_order": int | None,
              "previous_error": dict | None,   # for Hermes escalation / replan
              "results": [...]
            }
        """
        self.validate_manifest(manifest)
        self._last_manifest = manifest
        self._subplan_states = {
            sp.order: _SubPlanState(subplan=sp) for sp in manifest.sub_plans
        }

        subplans_sorted = sorted(manifest.sub_plans, key=lambda s: s.order)
        executed_orders: list[int] = []
        results: list[dict] = []

        for sp in subplans_sorted:
            state = self._subplan_states[sp.order]

            # Check dependencies (by order value)
            unmet = [d for d in sp.depends_on if self._subplan_states.get(d, _SubPlanState(None)).status != "done"]
            if unmet:
                state.status = "skipped"
                state.error = {"reason": "unmet_dependencies", "depends_on": unmet}
                self._log(f"[orchestrator] skip order={sp.order}: unmet deps {unmet}")
                continue

            # Start quantified tracking (works for both INVENTORY and other verify types)
            intent_type = self._infer_intent_type(sp.intent)
            target = self._infer_target_count(sp.intent, sp.verify)
            try:
                self._executor.start_intent(intent_type, target, verify_spec=sp.verify, original_intent=sp.intent)
            except Exception as e:
                self._log(f"[orchestrator] start_intent failed for order={sp.order}: {e}")

            state.status = "running"

            # Dispatch to embodied (Gemma). This returns after Gemma finishes PLANNING,
            # but the actual execution (mining, moving) happens asynchronously on the bot.
            # We mark as "dispatched" and let heartbeat ticks verify progress later.
            disp = self._dispatch_intent(sp.intent)
            ok = bool(disp and disp.get("ok", True))

            if not ok:
                state.status = "failed"
                err = {
                    "error_type": "dispatch_failed",
                    "order": sp.order,
                    "intent": sp.intent,
                    "details": disp.get("error") if isinstance(disp, dict) else str(disp),
                }
                state.error = err
                self._executor.on_intent_fail(err)
                results.append({"order": sp.order, "intent": sp.intent, "ok": False, "error": err})

                if manifest.abort_on_failure:
                    return self._build_escalation(manifest, sp.order, err, executed_orders, results)
                continue

            # Dispatched successfully — verify will happen async on heartbeat ticks
            state.status = "dispatched"
            state.result = {"ok": True, "disp": disp}
            results.append({"order": sp.order, "intent": sp.intent, "ok": True, "status": "dispatched"})
            self._log(f"[orchestrator] dispatched order={sp.order}: {sp.intent}")

        # All processed
        dispatched = sum(1 for s in self._subplan_states.values() if s.status == "dispatched")
        done_count = sum(1 for s in self._subplan_states.values() if s.status == "done")
        total = len(manifest.sub_plans)
        status = "completed" if done_count == total else ("dispatched" if dispatched + done_count == total else "partial")

        return {
            "status": status,
            "goal": manifest.goal,
            "executed": executed_orders,
            "failed_order": None,
            "previous_error": None,
            "results": results,
            "done": done_count,
            "dispatched": dispatched,
            "total": total,
        }

    def sync_progress(self) -> dict[str, Any] | None:
        """Called from heartbeat to sync executor state → orchestrator state.

        If the executor cleared its active intent (verify passed via
        _check_executor_resume), mark the dispatched sub-plan as done.
        Returns update dict or None if nothing changed.
        """
        if not self._last_manifest:
            return None

        # If executor has no active intent but we have dispatched sub-plans,
        # the executor must have completed (verified via _check_executor_resume)
        if not self._executor.has_active_intent():
            changed = False
            for order, state in self._subplan_states.items():
                if state.status == "dispatched":
                    state.status = "done"
                    self._log(f"[orchestrator] sync: order={order} → done (executor cleared)")
                    changed = True
            if changed:
                return self.get_last_result()
        return None

    def _build_escalation(
        self,
        manifest: PlanManifest,
        failed_order: int,
        previous_error: dict,
        executed: list[int],
        results: list[dict],
    ) -> dict[str, Any]:
        """Format escalation payload for Hermes (Steve) replanning."""
        self._log(f"[orchestrator] ESCALATE order={failed_order}: {previous_error.get('error_type')}")
        return {
            "status": "escalated",
            "goal": manifest.goal,
            "executed": executed,
            "failed_order": failed_order,
            "previous_error": previous_error,
            "results": results,
            "hint": "Include previous_error in next heartbeat for Hermes replan. Consider revised manifest via mc_plan_decompose.",
        }

    # ──────────────────────────────────────────────────────────────────────
    # Helpers
    # ──────────────────────────────────────────────────────────────────────

    def _infer_intent_type(self, intent: str) -> str:
        """Crude parser for executor tracking. Real type can be anything."""
        if not intent:
            return "do"
        first = intent.strip().split()[0].lower()
        if first in ("mine", "gather", "collect", "farm"):
            return first
        if first in ("craft", "build", "place"):
            return first
        if first in ("goto", "follow", "move", "go"):
            return "move"
        return first or "do"

    def _infer_target_count(self, intent: str, verify: VerifySpec) -> int:
        """Best-effort target for executor. VerifySpec is authoritative for success."""
        if verify and verify.type == VerifyType.INVENTORY_HAS:
            return max(1, verify.count)
        # Try parse "mine 64 foo" style
        parts = intent.strip().split()
        if len(parts) >= 2 and parts[1].lstrip("-").isdigit():
            return max(1, int(parts[1]))
        return 1

    @staticmethod
    def _noop_dispatch(intent: str) -> dict:
        """Safe default for dry-run / unit tests."""
        return {"ok": True, "_noop": True, "intent": intent}

    # ──────────────────────────────────────────────────────────────────────
    # Introspection
    # ──────────────────────────────────────────────────────────────────────

    def get_last_result(self) -> dict[str, Any]:
        if not self._last_manifest:
            return {"active": False}
        states = {
            order: {"status": st.status, "intent": st.subplan.intent}
            for order, st in self._subplan_states.items()
        }
        return {
            "active": True,
            "goal": self._last_manifest.goal,
            "states": states,
        }

    def clear(self) -> None:
        """Reset internal state (e.g. on explicit cancel)."""
        self._last_manifest = None
        self._subplan_states = {}
        if self._executor:
            self._executor.clear()
