#!/usr/bin/env python3
"""
QuantifiedIntentExecutor — Fase 2 Cross-Layer Coordination.

Tracks progress on quantified "mine N <item>" / "gather N <item>" intents
across L2 reflex preemption (runner) and L3 embodied execution.

- Captures inventory baseline at intent start (from /status or /inventory).
- On runner interrupt (detected in L4 heartbeat when mutex returns to IDLE),
  computes delta, re-dispatches adjusted-remaining intent via embodied.
- on_intent_complete verifies VerifySpec.INVENTORY_HAS against live state.
- on_intent_fail propagates failure context (no confusion with runner_interrupted).

Design constraints respected:
- Pure in-process module (no separate service).
- Uses plan_schema.VerifySpec (INVENTORY_HAS).
- Injected fetch/dispatch for testability and to avoid import cycles.
- Never polls /mutex/status (caller in heartbeat provides the signal via combat data).
- Does not touch runner hot path.
- No save/load_plan (still stubbed).
"""

from __future__ import annotations

import sys
from pathlib import Path
# Ensure repo root is importable
_repo_root = Path(__file__).resolve().parent.parent
if str(_repo_root) not in sys.path:
    sys.path.insert(0, str(_repo_root))

import time
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

from agents.plan_schema import VerifySpec, VerifyType


@dataclass
class _ActiveIntent:
    """Internal anchor for a quantified intent (baseline fixed at start)."""
    intent_type: str          # "mine", "gather", etc.
    item: str                 # e.g. "oak_log"
    target_count: int         # original N (e.g. 64)
    baseline_count: int       # inventory count at start_intent
    started_ts: float
    verify_spec: Optional[VerifySpec] = None
    last_gained: int = 0      # for reporting only
    original_intent: str = ""  # the full intent string for non-INVENTORY_HAS types
    resume_count: int = 0     # track resume attempts, max 3


class QuantifiedIntentExecutor:
    """
    Simple executor for resumable quantified intents.

    Typical lifecycle (called by agent_loop or higher layers):
        ex.start_intent("mine", 64, VerifySpec(type=VerifyType.INVENTORY_HAS, item="oak_log", count=64))
        ... embodied runs ...
        # heartbeat tick sees mutex IDLE + active:
        ex.resume_after_interrupt(runner_activity)
        # ... later when embodied reports done:
        ex.on_intent_complete()
        # or on failure from embodied:
        ex.on_intent_fail({"error_type": "...", ...})
    """

    # CONTROL_MODE.IDLE from bot/lib/mutex.js
    MUTEX_IDLE = 0

    def __init__(
        self,
        fetch_inventory: Optional[Callable[[], dict]] = None,
        dispatch_intent: Optional[Callable[[str], dict]] = None,
        log: Optional[Callable[[str], None]] = None,
    ):
        self._active: Optional[_ActiveIntent] = None
        self._fetch_inventory = fetch_inventory or self._noop_fetch
        self._dispatch_intent = dispatch_intent or self._noop_dispatch
        self._log = log or (lambda s: None)
        self._last_resume_ts: float = 0.0
        self._resume_debounce_s: float = 5.0  # guard against rapid re-dispatch spam

    # ──────────────────────────────────────────────────────────────────────
    # Public API
    # ──────────────────────────────────────────────────────────────────────

    def start_intent(
        self,
        intent_type: str,
        target_count: int,
        verify_spec: Optional[VerifySpec] = None,
        original_intent: str = "",
    ) -> bool:
        """
        Begin tracking a quantified intent. Snapshots current inventory as baseline.
        Safe to call multiple times (replaces previous active intent).
        """
        if target_count <= 0:
            self._log("[executor] start_intent ignored: target_count <= 0")
            return False

        item = ""
        if verify_spec and verify_spec.type == VerifyType.INVENTORY_HAS:
            item = verify_spec.item or ""
        if not item:
            # Fallback: derive from intent_type if it contains the item? Keep minimal.
            # Caller should pass proper verify_spec for INVENTORY_HAS intents.
            self._log(f"[executor] start_intent warning: no item in verify_spec for {intent_type}")
            item = "unknown"

        try:
            inv = self._fetch_inventory()
            baseline = self._extract_item_count(inv, item)
        except Exception as e:
            self._log(f"[executor] start_intent baseline fetch failed: {e}")
            baseline = 0

        self._active = _ActiveIntent(
            intent_type=intent_type,
            item=item,
            target_count=target_count,
            baseline_count=baseline,
            started_ts=time.time(),
            verify_spec=verify_spec,
            last_gained=0,
            original_intent=original_intent,
        )
        self._log(
            f"[executor] start_intent: {intent_type} {target_count} {item} "
            f"(baseline={baseline}, verify_count={verify_spec.count if verify_spec else '?'})"
        )
        return True

    def resume_after_interrupt(self, runner_activity: Optional[dict] = None) -> Optional[str]:
        """
        Called from L4 heartbeat when an active quantified intent exists and
        mutex is IDLE (post L2 preemption).

        Computes inventory delta since (fixed) baseline. Re-dispatches an
        adjusted-remaining intent string to embodied service.

        Returns the dispatched intent string on success, or None / special token.
        Never raises to the heartbeat tick.
        """
        if not self._active:
            return None

        a = self._active
        now = time.time()
        if now - self._last_resume_ts < self._resume_debounce_s:
            return None  # debounce — previous resume still settling

        # Max resume guard: after 3 attempts, give up and clear
        a.resume_count += 1
        if a.resume_count > 3:
            self._log(f"[executor] resume: max attempts ({a.resume_count}) — giving up on {a.intent_type} {a.item}")
            self._active = None
            return "max_resumes"

        # For non-INVENTORY_HAS intents (fill, place, goto), just re-dispatch
        # the original intent — progress can't be tracked via inventory delta.
        # After dispatching, clear the active intent — the orchestrator's
        # sync_progress will handle completion via heartbeat.
        if a.verify_spec and a.verify_spec.type != VerifyType.INVENTORY_HAS:
            if a.original_intent:
                self._log(f"[executor] resume (non-quantified): re-dispatching '{a.original_intent}' (attempt {a.resume_count}/3)")
                result = self._dispatch_intent(a.original_intent)
                self._last_resume_ts = now
                if result and result.get("ok"):
                    self._active = None  # let orchestrator sync handle completion
                    return a.original_intent
            return None

        try:
            inv = self._fetch_inventory()
            current = self._extract_item_count(inv, a.item)
            gained = max(0, current - a.baseline_count)
            a.last_gained = gained

            # Absolute verify takes precedence for "already done"
            if a.verify_spec and a.verify_spec.type == VerifyType.INVENTORY_HAS:
                if current >= a.verify_spec.count:
                    self._log(f"[executor] resume: already satisfied (current={current} >= verify={a.verify_spec.count})")
                    self._active = None
                    return "satisfied"

            remaining = max(0, a.target_count - gained)
            if remaining <= 0:
                self._log(f"[executor] resume: target met by progress (gained={gained})")
                self._active = None
                return "satisfied"

            adjusted_intent = f"{a.intent_type} {remaining} {a.item}"

            self._log(
                f"[executor] resume_after_interrupt: baseline={a.baseline_count} "
                f"current={current} gained={gained} remaining={remaining} "
                f"-> '{adjusted_intent}' (runner_activity total={runner_activity.get('total', 0) if runner_activity else 0})"
            )

            result = self._dispatch_intent(adjusted_intent)
            self._last_resume_ts = now

            if result and result.get("ok"):
                # Active anchor stays (baseline fixed). Next resume (if any) will delta further from original baseline.
                return adjusted_intent
            else:
                self._log(f"[executor] re-dispatch returned not-ok: {result}")
                return None

        except Exception as e:
            self._log(f"[executor] resume_after_interrupt error (non-fatal): {e}")
            return None

    def on_intent_complete(self) -> bool:
        """
        Called by owner (agent_loop / Hermes layer) when the current embodied
        intent reports success. Performs final VerifySpec check.
        Clears active on verified success.
        """
        if not self._active:
            return True

        a = self._active
        try:
            inv = self._fetch_inventory()
            current = self._extract_item_count(inv, a.item)
            gained = max(0, current - a.baseline_count)

            ok = False
            if a.verify_spec and a.verify_spec.type == VerifyType.INVENTORY_HAS:
                ok = current >= a.verify_spec.count
            else:
                ok = gained >= a.target_count

            self._log(
                f"[executor] on_intent_complete: {a.intent_type} {a.item} "
                f"current={current} gained={gained} target={a.target_count} "
                f"verify={a.verify_spec.count if a.verify_spec else 'n/a'} -> ok={ok}"
            )

            if ok:
                self._active = None
            return ok

        except Exception as e:
            self._log(f"[executor] on_intent_complete verify error: {e}")
            # Conservative: do not clear on error; owner can force via clear()
            return False

    def on_intent_fail(self, previous_error: Optional[dict] = None) -> None:
        """
        Propagate failure from embodied (Gemma) to L3/Steve context.
        Clears the active intent (distinct from runner_interrupted which triggers resume).
        """
        self._log(f"[executor] on_intent_fail: previous_error={previous_error}")
        self._active = None

    def get_state(self) -> dict[str, Any]:
        """Return snapshot for body_session.executor_state."""
        if not self._active:
            return {"active": False}

        a = self._active
        try:
            inv = self._fetch_inventory()
            current = self._extract_item_count(inv, a.item)
            gained = max(0, current - a.baseline_count)
            remaining = max(0, a.target_count - gained)
        except Exception:
            current = a.baseline_count + a.last_gained
            gained = a.last_gained
            remaining = max(0, a.target_count - gained)

        return {
            "active": True,
            "active_intent": f"{a.intent_type} {a.target_count} {a.item}",
            "intent_type": a.intent_type,
            "item": a.item,
            "target": a.target_count,
            "baseline": a.baseline_count,
            "progress": gained,
            "remaining": remaining,
            "started_ts": a.started_ts,
            "last_gained": a.last_gained,
        }

    def has_active_intent(self) -> bool:
        return self._active is not None

    def clear(self) -> None:
        """Force-clear (e.g. on explicit cancel or escalation)."""
        self._active = None
        self._last_resume_ts = 0.0

    # ──────────────────────────────────────────────────────────────────────
    # Helpers (inventory shape tolerant)
    # ──────────────────────────────────────────────────────────────────────

    def _extract_item_count(self, inv: dict, item: str) -> int:
        """Support both /status flat list and /inventory categories formats."""
        if not inv or not item:
            return 0

        # Flat list from getFullState().inventory
        for entry in inv.get("items", []) or inv.get("inventory", []):
            if isinstance(entry, dict) and entry.get("name") == item:
                return int(entry.get("count", 0))

        # Categories from fetch_bot_inventory()
        cats = inv.get("categories") or {}
        for cat_items in cats.values():
            if isinstance(cat_items, list):
                for entry in cat_items:
                    if isinstance(entry, dict) and entry.get("name") == item:
                        return int(entry.get("count", 0))

        # Fallback: direct key (rare)
        if inv.get("name") == item:
            return int(inv.get("count", 0))

        return 0

    @staticmethod
    def _noop_fetch() -> dict:
        return {"items": [], "categories": {}, "summary": "noop"}

    @staticmethod
    def _noop_dispatch(intent: str) -> dict:
        # For unit tests / dry-run: pretend success, no network.
        return {"ok": True, "_noop": True, "intent": intent}


# Convenience singleton for simple import sites (agent_loop injects real fns at startup).
_executor: Optional[QuantifiedIntentExecutor] = None


def get_executor() -> QuantifiedIntentExecutor:
    """Return the process-wide executor (created on first use if needed)."""
    global _executor
    if _executor is None:
        _executor = QuantifiedIntentExecutor()
    return _executor


def set_executor(executor: QuantifiedIntentExecutor) -> None:
    """Inject (used by agent_loop at startup with real fetch/dispatch)."""
    global _executor
    _executor = executor
