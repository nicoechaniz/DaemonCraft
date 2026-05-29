"""Unit tests for PlanOrchestrator + Fase 3 PlanManifest/SubPlan (anti-hallucination)."""

import pytest
import sys
from pathlib import Path

# Ensure agents package is importable
_repo_root = Path(__file__).resolve().parent.parent
if str(_repo_root) not in sys.path:
    sys.path.insert(0, str(_repo_root))

from agents.plan_orchestrator import PlanOrchestrator
from agents.plan_schema import PlanManifest, SubPlan, VerifySpec, VerifyType
from agents.plan_executor import QuantifiedIntentExecutor


# ── Helpers ──────────────────────────────────────────────────────────────

def _make_inv(items):
    return {"items": [{"name": name, "count": count} for name, count in items]}


def _make_executor(inv_items=(), dispatch_ok=True):
    inv = _make_inv(inv_items)
    dispatched = []

    def fetch():
        return inv

    def dispatch(intent):
        dispatched.append(intent)
        return {"ok": dispatch_ok}

    ex = QuantifiedIntentExecutor(fetch_inventory=fetch, dispatch_intent=dispatch)
    ex._test_dispatched = dispatched
    ex._test_inv = inv
    return ex


def _make_orchestrator(inv_items=(), dispatch_ok=True, grant_progress_on_dispatch=True):
    """grant_progress_on_dispatch: if True (happy path), dispatch bumps inv so verify passes in sync on_complete."""
    ex = _make_executor(inv_items, dispatch_ok)
    dispatched = ex._test_dispatched

    def dispatch(intent):
        dispatched.append(intent)
        if grant_progress_on_dispatch and dispatch_ok and ex._active and ex._active.verify_spec:
            v = ex._active.verify_spec
            if v.type == VerifyType.INVENTORY_HAS and v.item:
                for entry in ex._test_inv.get("items", []):
                    if entry.get("name") == v.item:
                        entry["count"] = max(entry.get("count", 0), v.count)
                        break
                else:
                    ex._test_inv["items"].append({"name": v.item, "count": v.count})
        return {"ok": dispatch_ok}

    orch = PlanOrchestrator(executor=ex, dispatch_intent=dispatch)
    orch._test_dispatched = dispatched
    orch._test_ex = ex
    return orch


# ── Schema basics ────────────────────────────────────────────────────────

def test_subplan_requires_verify_in_from_dict():
    with pytest.raises(ValueError, match="requires 'verify'"):
        SubPlan.from_dict({"intent": "mine 10 stone", "order": 0, "depends_on": []})


def test_planmanifest_roundtrip():
    v = VerifySpec(type=VerifyType.INVENTORY_HAS, item="oak_log", count=32)
    sp = SubPlan(intent="mine 32 oak_log", verify=v, order=1, depends_on=[0])
    m = PlanManifest(goal="get logs for house", sub_plans=[sp], estimated_time_s=120)
    d = m.to_dict()
    m2 = PlanManifest.from_dict(d)
    assert m2.goal == m.goal
    assert m2.sub_plans[0].intent == "mine 32 oak_log"
    assert m2.sub_plans[0].verify.item == "oak_log"


# ── validate_manifest (anti-hallucination guard) ─────────────────────────

def test_validate_rejects_missing_verify():
    orch = PlanOrchestrator()
    # Construct via dict path that bypasses dataclass guard (simulates bad LLM output)
    bad_manifest = PlanManifest(
        goal="bad plan",
        sub_plans=[
            SubPlan(intent="mine 10 dirt", verify=None, order=0, depends_on=[])  # type: ignore
        ],
    )
    with pytest.raises(ValueError, match="missing REQUIRED VerifySpec"):
        orch.validate_manifest(bad_manifest)


def test_validate_rejects_bad_verify_type():
    orch = PlanOrchestrator()
    bad = PlanManifest(
        goal="x",
        sub_plans=[SubPlan(intent="do thing", verify=object(), order=0)],  # type: ignore
    )
    with pytest.raises(ValueError, match="missing REQUIRED VerifySpec"):
        orch.validate_manifest(bad)


def test_validate_accepts_good_manifest():
    orch = PlanOrchestrator()
    good = PlanManifest(
        goal="gather starter wood",
        sub_plans=[
            SubPlan(
                intent="mine 16 oak_log",
                verify=VerifySpec(type=VerifyType.INVENTORY_HAS, item="oak_log", count=16),
                order=0,
            ),
            SubPlan(
                intent="craft 4 oak_planks",
                verify=VerifySpec(type=VerifyType.INVENTORY_HAS, item="oak_planks", count=4),
                order=1,
                depends_on=[0],
            ),
        ],
        estimated_time_s=90,
    )
    assert orch.validate_manifest(good) is True


# ── execute_plan order + depends_on ─────────────────────────────────────

def test_execute_runs_in_order_respecting_depends():
    """Subplans with depends_on must wait; execution order must be deterministic."""
    orch = _make_orchestrator([("oak_log", 0)], grant_progress_on_dispatch=True)

    manifest = PlanManifest(
        goal="logs then planks",
        sub_plans=[
            SubPlan(
                intent="mine 8 oak_log",
                verify=VerifySpec(type=VerifyType.INVENTORY_HAS, item="oak_log", count=8),
                order=10,
                depends_on=[],
            ),
            SubPlan(
                intent="craft 32 oak_planks",
                verify=VerifySpec(type=VerifyType.INVENTORY_HAS, item="oak_planks", count=32),
                order=20,
                depends_on=[10],
            ),
            SubPlan(
                intent="craft 8 sticks",
                verify=VerifySpec(type=VerifyType.INVENTORY_HAS, item="stick", count=8),
                order=30,
                depends_on=[20],
            ),
        ],
    )

    outcome = orch.execute_plan(manifest)

    assert outcome["status"] in ("completed", "partial")
    # Should have executed in ascending order, deps satisfied
    exec_orders = outcome["executed"]
    assert exec_orders == [10, 20, 30], f"Unexpected execution order: {exec_orders}"

    # Verify intents were dispatched (orchestrator + executor)
    dispatched = orch._test_dispatched
    assert "mine 8 oak_log" in dispatched
    assert "craft 32 oak_planks" in dispatched
    assert "craft 8 sticks" in dispatched


def test_execute_skips_on_unmet_dep_in_same_pass():
    """If depends_on points to future order, it skips (supports incremental advance)."""
    orch = _make_orchestrator([("dirt", 0)], grant_progress_on_dispatch=True)

    manifest = PlanManifest(
        goal="two phase with forward ref (unusual but tests guard)",
        sub_plans=[
            SubPlan(
                intent="gather 5 dirt",
                verify=VerifySpec(type=VerifyType.INVENTORY_HAS, item="dirt", count=5),
                order=2,
                depends_on=[5],
            ),
            SubPlan(
                intent="mine 12 dirt",
                verify=VerifySpec(type=VerifyType.INVENTORY_HAS, item="dirt", count=12),
                order=5,
                depends_on=[],
            ),
        ],
    )

    outcome = orch.execute_plan(manifest)
    # phaseB (order2) skipped because 5 not done yet when 2 processed
    states = orch.get_last_result()["states"]
    assert states[2]["status"] == "skipped"
    assert states[5]["status"] == "done"
    assert outcome["status"] == "partial"


def test_execute_escalates_on_verify_failure():
    """When on_intent_complete returns False and abort_on_failure, return escalated + previous_error."""
    orch = _make_orchestrator([("cobblestone", 2)], grant_progress_on_dispatch=False)  # never reaches 64

    manifest = PlanManifest(
        goal="get lots of cobble",
        sub_plans=[
            SubPlan(
                intent="mine 64 cobblestone",
                verify=VerifySpec(type=VerifyType.INVENTORY_HAS, item="cobblestone", count=64),
                order=0,
            ),
        ],
        abort_on_failure=True,
    )

    outcome = orch.execute_plan(manifest)

    assert outcome["status"] == "escalated"
    assert outcome["failed_order"] == 0
    assert outcome["previous_error"]["error_type"] == "verify_failed"
    assert "previous_error" in outcome
    assert outcome["previous_error"]["order"] == 0


def test_execute_escalates_on_dispatch_failure():
    orch = _make_orchestrator(dispatch_ok=False)

    manifest = PlanManifest(
        goal="simple move",
        sub_plans=[
            SubPlan(
                intent="goto 100 64 200",
                verify=VerifySpec(type=VerifyType.POSITION_REACHED, target_x=100, target_y=64, target_z=200),
                order=0,
            ),
        ],
    )

    outcome = orch.execute_plan(manifest)
    assert outcome["status"] == "escalated"
    assert outcome["previous_error"]["error_type"] == "dispatch_failed"


def test_validate_and_execute_empty_manifest_ok():
    orch = PlanOrchestrator()
    m = PlanManifest(goal="do nothing")
    assert orch.validate_manifest(m) is True
    out = orch.execute_plan(m)
    assert out["status"] == "completed"
    assert out["total"] == 0
