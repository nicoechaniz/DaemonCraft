"""Unit tests for QuantifiedIntentExecutor (Fase 2 Cross-Layer Coordination)."""

import pytest
import sys
from pathlib import Path

# Ensure agents package is importable (add repo root, not agents/ subdir)
_repo_root = Path(__file__).resolve().parent.parent
if str(_repo_root) not in sys.path:
    sys.path.insert(0, str(_repo_root))

from agents.plan_executor import QuantifiedIntentExecutor
from agents.plan_schema import VerifySpec, VerifyType


# ── Helpers ──────────────────────────────────────────────────────────────

def _make_inv(items):
    """Build inventory dict in the flat-list shape the executor expects."""
    return {"items": [
        {"name": name, "count": count}
        for name, count in items
    ]}


def _make_executor(inv_items=(), dispatch_ok=True):
    """Factory for an executor with controllable fetch_inventory and dispatch_intent."""
    inv = _make_inv(inv_items)
    dispatched = []

    def fetch():
        return inv

    def dispatch(intent):
        dispatched.append(intent)
        return {"ok": dispatch_ok}

    ex = QuantifiedIntentExecutor(
        fetch_inventory=fetch,
        dispatch_intent=dispatch,
    )
    # Attach dispatched list for assertions
    ex._test_dispatched = dispatched
    # Allow mutating the inventory for dynamic tests
    ex._test_inv = inv
    ex._test_fetch = fetch
    return ex


# ── start_intent ─────────────────────────────────────────────────────────

def test_start_intent_sets_baseline():
    ex = _make_executor([("oak_log", 12)])
    ok = ex.start_intent("mine", 64, VerifySpec(
        type=VerifyType.INVENTORY_HAS, item="oak_log", count=64
    ))
    assert ok is True
    assert ex.has_active_intent()
    state = ex.get_state()
    assert state["active"] is True
    assert state["baseline"] == 12
    assert state["target"] == 64
    assert state["item"] == "oak_log"


def test_start_intent_zero_count_ignored():
    ex = _make_executor([("oak_log", 5)])
    ok = ex.start_intent("mine", 0, VerifySpec(
        type=VerifyType.INVENTORY_HAS, item="oak_log", count=10
    ))
    assert ok is False
    assert not ex.has_active_intent()


def test_start_intent_replaces_previous():
    ex = _make_executor([("oak_log", 5)])
    ex.start_intent("mine", 64, VerifySpec(
        type=VerifyType.INVENTORY_HAS, item="oak_log", count=64
    ))
    ex.start_intent("gather", 32, VerifySpec(
        type=VerifyType.INVENTORY_HAS, item="wheat", count=32
    ))
    state = ex.get_state()
    assert state["item"] == "wheat"
    assert state["target"] == 32


def test_start_intent_without_verify_falls_back():
    ex = _make_executor([("stone", 3)])
    ok = ex.start_intent("mine", 64, None)
    assert ok is True
    state = ex.get_state()
    assert state["item"] == "unknown"


# ── resume_after_interrupt ───────────────────────────────────────────────

def test_resume_after_interrupt_no_progress():
    """Baseline = 12, current = 12 → remaining = 64 → re-dispatch 'mine 64 oak_log'."""
    ex = _make_executor([("oak_log", 12)])
    ex.start_intent("mine", 64, VerifySpec(
        type=VerifyType.INVENTORY_HAS, item="oak_log", count=64
    ))
    result = ex.resume_after_interrupt()
    assert result == "mine 64 oak_log"
    assert len(ex._test_dispatched) == 1
    assert ex._test_dispatched[0] == "mine 64 oak_log"
    # Active intent persists (baseline unchanged)
    assert ex.has_active_intent()


def test_resume_after_interrupt_with_progress():
    """Baseline = 12, current = 23 → gained = 11 → remaining = 53."""
    ex = _make_executor([("oak_log", 12)])
    ex.start_intent("mine", 64, VerifySpec(
        type=VerifyType.INVENTORY_HAS, item="oak_log", count=64
    ))
    # Simulate progress: inventory grew
    ex._test_inv["items"] = [{"name": "oak_log", "count": 23}]
    result = ex.resume_after_interrupt()
    assert result == "mine 53 oak_log"
    assert ex._test_dispatched[0] == "mine 53 oak_log"


def test_resume_already_satisfied():
    """Current inventory already meets VerifySpec → returns 'satisfied', clears active."""
    ex = _make_executor([("oak_log", 70)])
    ex.start_intent("mine", 64, VerifySpec(
        type=VerifyType.INVENTORY_HAS, item="oak_log", count=64
    ))
    result = ex.resume_after_interrupt()
    assert result == "satisfied"
    assert not ex.has_active_intent()
    assert len(ex._test_dispatched) == 0  # No re-dispatch


def test_resume_no_active_intent():
    ex = _make_executor()
    result = ex.resume_after_interrupt()
    assert result is None


def test_resume_debounce():
    """Two rapid resume calls → second is debounced."""
    ex = _make_executor([("oak_log", 12)])
    ex.start_intent("mine", 64, VerifySpec(
        type=VerifyType.INVENTORY_HAS, item="oak_log", count=64
    ))
    result1 = ex.resume_after_interrupt()
    assert result1 is not None

    # Second call within debounce window → None
    result2 = ex.resume_after_interrupt()
    assert result2 is None
    assert len(ex._test_dispatched) == 1  # Only one dispatch


def test_resume_dispatch_failure():
    """When dispatch returns not-ok, resume returns None."""
    ex = _make_executor([("oak_log", 12)], dispatch_ok=False)
    ex.start_intent("mine", 64, VerifySpec(
        type=VerifyType.INVENTORY_HAS, item="oak_log", count=64
    ))
    result = ex.resume_after_interrupt()
    assert result is None
    # Active intent still exists (not cleared on dispatch failure)
    assert ex.has_active_intent()


# ── on_intent_complete ───────────────────────────────────────────────────

def test_on_intent_complete_verified():
    """Inventory meets VerifySpec → True, clears active."""
    ex = _make_executor([("oak_log", 65)])
    ex.start_intent("mine", 64, VerifySpec(
        type=VerifyType.INVENTORY_HAS, item="oak_log", count=64
    ))
    ok = ex.on_intent_complete()
    assert ok is True
    assert not ex.has_active_intent()


def test_on_intent_complete_not_yet():
    """Inventory below VerifySpec → False, active persists."""
    ex = _make_executor([("oak_log", 30)])
    ex.start_intent("mine", 64, VerifySpec(
        type=VerifyType.INVENTORY_HAS, item="oak_log", count=64
    ))
    ok = ex.on_intent_complete()
    assert ok is False
    assert ex.has_active_intent()


def test_on_intent_complete_gained_enough():
    """Inventory meets VerifySpec count → True, clears active (gather variant)."""
    ex = _make_executor([("wheat", 5)])
    ex.start_intent("gather", 32, VerifySpec(
        type=VerifyType.INVENTORY_HAS, item="wheat", count=32
    ))
    ex._test_inv["items"] = [{"name": "wheat", "count": 35}]
    ok = ex.on_intent_complete()
    assert ok is True
    assert not ex.has_active_intent()


def test_on_intent_complete_no_active():
    ex = _make_executor()
    ok = ex.on_intent_complete()
    assert ok is True


# ── on_intent_fail ───────────────────────────────────────────────────────

def test_on_intent_fail_clears_active():
    ex = _make_executor([("oak_log", 12)])
    ex.start_intent("mine", 64, VerifySpec(
        type=VerifyType.INVENTORY_HAS, item="oak_log", count=64
    ))
    assert ex.has_active_intent()
    ex.on_intent_fail({"error_type": "tool_failure"})
    assert not ex.has_active_intent()


# ── get_state ────────────────────────────────────────────────────────────

def test_get_state_idle():
    ex = _make_executor()
    state = ex.get_state()
    assert state == {"active": False}


def test_get_state_with_progress():
    ex = _make_executor([("wheat", 5)])
    ex.start_intent("gather", 32, VerifySpec(
        type=VerifyType.INVENTORY_HAS, item="wheat", count=32
    ))
    ex._test_inv["items"] = [{"name": "wheat", "count": 18}]
    state = ex.get_state()
    assert state["active"] is True
    assert state["progress"] == 13
    assert state["remaining"] == 19
    assert state["baseline"] == 5


# ── clear ────────────────────────────────────────────────────────────────

def test_clear_drops_active():
    ex = _make_executor([("oak_log", 12)])
    ex.start_intent("mine", 64, VerifySpec(
        type=VerifyType.INVENTORY_HAS, item="oak_log", count=64
    ))
    assert ex.has_active_intent()
    ex.clear()
    assert not ex.has_active_intent()
    state = ex.get_state()
    assert state == {"active": False}


# ── _extract_item_count (categories format) ──────────────────────────────

def test_extract_from_categories():
    """_extract_item_count handles the fetch_bot_inventory() categories shape."""
    ex = _make_executor()
    inv = {
        "categories": {
            "blocks": [
                {"name": "oak_log", "count": 15},
                {"name": "stone", "count": 42},
            ],
            "tools": [
                {"name": "iron_pickaxe", "count": 1},
            ]
        }
    }
    assert ex._extract_item_count(inv, "oak_log") == 15
    assert ex._extract_item_count(inv, "stone") == 42
    assert ex._extract_item_count(inv, "diamond") == 0
