#!/usr/bin/env python3
"""
DaemonCraft agent loop — Autonomía Corporal.

Runs alongside the per-agent gateway. Two modes seamlessly integrated:

  1. PLAN ACTIVE → autonomous execution via Gemma-Andy ($0/call).
     Reads workspace/plan.json, feeds steps to embodied service,
     verifies against machine-checkable predicates, advances or escalates.

  2. NO PLAN → idle heartbeat injector.
     Gathers world state and sends to gateway every ~30s.

Infrastructure threads (always running):
  - WebSocket listener (chat tracking, quest events, interrupts)
  - Quest engine (blueprint phase advancement via scoreboards)
  - Daemon guardian (creative mode + effects, conditional on DAEMON_GUARDIAN=1)

CONTRACT: Steve (MiniMax $) owns plans, verification, escalations.
Gemma-Andy (Ollama $0) owns execution of concrete intents.
The loop is the glue: finite-state controller, not informal loop.

Usage:
    python agent_loop.py --profile steve --interval 7
"""

import argparse
import json
import os
import signal
import sys
import threading
import time
import urllib.request
from pathlib import Path

# Ensure Hermes is on path
HERMES_DIR = Path.home() / ".hermes" / "hermes-agent"
if str(HERMES_DIR) not in sys.path:
    sys.path.insert(0, str(HERMES_DIR))

# Import plan schema from same directory (Autonomía Corporal)
_AGENTS_DIR = Path(__file__).resolve().parent
if str(_AGENTS_DIR) not in sys.path:
    sys.path.insert(0, str(_AGENTS_DIR))
from plan_schema import (
    Plan, PlanState, DangerLevel, VerifyType, load_plan, save_plan,
)

MC_API_URL = os.getenv("MC_API_URL", "http://localhost:3001")
EMBODIED_SERVICE_URL = os.getenv("EMBODIED_SERVICE_URL", "http://localhost:7790")
BOT_USERNAME = os.getenv("MC_USERNAME", "Steve").lower()

# DC-132 metrics — append-only JSONL per cast per UTC day. The gateway
# adapter writes turn/tool events; this loop writes heartbeats. Schema
# is documented in scripts/agent-metrics-report.py.
_METRICS_DIR_DEFAULT = Path.home() / ".hermes" / "metrics"
METRICS_CAST = os.getenv("MC_METRICS_CAST", "")  # set by daemoncraft.py launcher
METRICS_DIR = Path(os.getenv("MC_METRICS_DIR", str(_METRICS_DIR_DEFAULT)))


def _emit_metric(kind: str, **fields) -> None:
    """Append a JSON line to ~/.hermes/metrics/<cast>/<date>.jsonl. Best-effort.

    Uses a single os.write() with O_APPEND so writes shorter than PIPE_BUF
    (typically 4 KB on Linux) are POSIX-atomic — even with concurrent writers
    or a process kill mid-write, you can't get a half-written line. The
    report script tolerates truncated lines anyway, but this prevents them
    in the first place.
    """
    if not METRICS_CAST:
        return
    try:
        import datetime as _dt
        now = _dt.datetime.utcnow()
        cast_dir = METRICS_DIR / METRICS_CAST
        cast_dir.mkdir(parents=True, exist_ok=True)
        path = cast_dir / f"{now.date().isoformat()}.jsonl"
        record = {
            "ts": now.isoformat(timespec="seconds") + "Z",
            "cast": METRICS_CAST,
            "agent": BOT_USERNAME.capitalize(),
            "kind": kind,
            **fields,
        }
        line = (json.dumps(record, separators=(",", ":")) + "\n").encode("utf-8")
        fd = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)
        try:
            os.write(fd, line)
        finally:
            os.close(fd)
    except Exception:
        # Metrics must never break the heartbeat loop.
        pass


# ═════════════════════════════════════════════════════════════════════════════════════════════════════════
# HTTP helpers
# ═════════════════════════════════════════════════════════════════════════════════════════════════════════

def _post_json(path: str, payload: dict) -> bool:
    """POST JSON to the bot server. Returns True on success."""
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        f"{MC_API_URL}{path}",
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return resp.status < 300
    except Exception as e:
        print(f"[loop] POST {path} failed: {e}", flush=True)
        return False


def _get_json(path: str) -> dict:
    """GET JSON from the bot server. Returns {} on failure."""
    try:
        with urllib.request.urlopen(f"{MC_API_URL}{path}", timeout=5) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception:
        return {}


def send_heartbeat_context(status: dict, nearby: dict, inventory: dict, plan: dict, events: list,
                          body_session: dict | None = None) -> bool:
    """Send a perception snapshot to the gateway via the bot server."""
    payload = {
        "status": status,
        "nearby": nearby,
        "inventory": inventory,
        "plan": plan,
        "events": events,
    }
    if body_session:
        payload["body_session"] = body_session
    return _post_json("/heartbeat/context", payload)


def send_agent_heartbeat(next_turn_in: float | None = None, turn_in_progress: bool = False):
    """Send legacy heartbeat to bot server for dashboard display."""
    _post_json("/agent/heartbeat", {
        "nextTurnIn": next_turn_in,
        "turnInProgress": turn_in_progress,
    })


def fetch_plan() -> dict:
    """Fetch the bot's current plan from the bot server."""
    try:
        data = _get_json("/plan")
        return data.get("data", {})
    except Exception:
        return {}


def fetch_bot_status() -> dict:
    """Fetch bot status (health, position, food, etc.)."""
    try:
        data = _get_json("/status")
        return data.get("data", {})
    except Exception:
        return {}


def fetch_bot_nearby() -> dict:
    """Fetch nearby entities and blocks."""
    try:
        data = _get_json("/nearby")
        return data.get("data", {})
    except Exception:
        return {}


def fetch_bot_inventory() -> dict:
    """Fetch bot inventory."""
    try:
        data = _get_json("/inventory")
        return data.get("data", {})
    except Exception:
        return {}


# ══════════════════════════════════════════════════════════════════════════════════════════════════════════
# Autonomía Corporal — Plan execution (Gemma-Andy $0/call)
# ══════════════════════════════════════════════════════════════════════════════════════════════════════════

_MAX_EMBODIED_RETRIES = 3
_EMBODIED_BACKOFF_BASE = 2.0


def _log_event(event: str, **fields) -> None:
    """Emit a structured JSON log line."""
    record = {"ts": time.time(), "bot": BOT_USERNAME, "event": event, **fields}
    print(json.dumps(record, separators=(",", ":")), flush=True)


def call_embodied(intent: str, deadline_s: int = 20) -> dict:
    """Call POST /intent on the embodied service. Retries with backoff."""
    last_error = None
    for attempt in range(_MAX_EMBODIED_RETRIES + 1):
        payload = json.dumps({"intent": intent, "deadline_seconds": deadline_s}).encode("utf-8")
        req = urllib.request.Request(
            f"{EMBODIED_SERVICE_URL}/intent",
            data=payload,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=deadline_s + 10) as resp:
                body = resp.read().decode("utf-8")
                result = json.loads(body) if body else {"ok": True}
            if result.get("ok") is not None:
                return result
        except Exception as e:
            last_error = str(e)
        if attempt < _MAX_EMBODIED_RETRIES:
            delay = _EMBODIED_BACKOFF_BASE ** attempt
            time.sleep(delay)
    _log_event("embodied_unreachable", attempts=_MAX_EMBODIED_RETRIES + 1, last_error=last_error)
    return {"ok": False, "_error": f"embodied_service_unreachable: {last_error}"}


def _check_danger(embodied_result: dict) -> DangerLevel | None:
    """Extract danger level from embodied service response."""
    plan = embodied_result.get("plan", {})
    risk_str = plan.get("operational_risk", "")
    if not risk_str or risk_str == "none":
        return None
    return DangerLevel.parse_risk(risk_str)


def verify_step(step, embodied_result: dict) -> tuple[bool, str]:
    """Verify a step against embodied service response and bot state."""
    verify = step.verify

    if not embodied_result.get("ok"):
        return False, f"embodied_not_ok: {embodied_result.get('_error', 'unknown')}"

    execution_results = embodied_result.get("execution_results", [])
    if not execution_results:
        return False, "no_execution_results"

    failed = [r for r in execution_results if not r.get("ok")]
    if failed:
        reasons = [f"{r.get('tool', '?')}:{r.get('error_type', '?')}" for r in failed]
        return False, f"tool_failures: {', '.join(reasons)}"

    try:
        if verify.type == VerifyType.INVENTORY_HAS:
            inv = fetch_bot_inventory()
            item = verify.item.lower()
            count = 0
            for key, val in inv.items():
                if isinstance(key, str) and key.lower() == item:
                    count += int(val) if isinstance(val, (int, float)) else 0
            categories = inv.get("categories", {})
            if isinstance(categories, dict):
                for cat in categories.values():
                    if isinstance(cat, dict):
                        for citem, ccount in cat.items():
                            if citem.lower() == item:
                                count += int(ccount) if isinstance(ccount, (int, float)) else 0
            passed = count >= verify.count
            return passed, f"inventory_has({item}): {count} >= {verify.count} → {'PASS' if passed else 'FAIL'}"

        elif verify.type == VerifyType.POSITION_REACHED:
            status = fetch_bot_status()
            pos = status.get("position", {})
            if not pos:
                return False, "no_position_data"
            dist = ((pos.get("x", 0) - verify.target_x) ** 2 + (pos.get("z", 0) - verify.target_z) ** 2) ** 0.5
            passed = dist <= verify.max_distance
            return passed, f"position_reached: dist={dist:.1f} ≤ {verify.max_distance} → {'PASS' if passed else 'FAIL'}"

        elif verify.type == VerifyType.AREA_CLEAR:
            nearby = fetch_bot_nearby()
            blocks = nearby.get("blocks", nearby.get("nearby_blocks", []))
            if not blocks:
                return False, "no_nearby_blocks_data"
            blocks_above = sum(1 for b in blocks
                             if verify.x1 <= b.get("x", 0) <= verify.x2
                             and verify.z1 <= b.get("z", 0) <= verify.z2
                             and b.get("y", 0) > verify.y)
            passed = blocks_above <= verify.max_blocks_above
            return passed, f"area_clear: {blocks_above} blocks above ≤ {verify.max_blocks_above} → {'PASS' if passed else 'FAIL'}"

        elif verify.type == VerifyType.ENTITY_NEARBY:
            nearby = fetch_bot_nearby()
            entities = nearby.get("entities", nearby.get("nearby_entities", []))
            for e in entities:
                etype = (e.get("type") or e.get("name", "")).lower()
                if verify.entity_type.lower() in etype:
                    return True, f"entity_nearby({verify.entity_type}): found"
            return False, f"entity_nearby({verify.entity_type}): not found"

        elif verify.type == VerifyType.BLOCK_PLACED:
            nearby = fetch_bot_nearby()
            blocks = nearby.get("blocks", nearby.get("nearby_blocks", []))
            for b in blocks:
                if (b.get("x") == verify.block_x and b.get("y") == verify.block_y
                        and b.get("z") == verify.block_z):
                    bname = (b.get("name") or "").lower()
                    if verify.block_material:
                        material_ok = verify.block_material.lower() in bname
                        return material_ok, f"block_placed: found={bname} match={material_ok}"
                    return True, f"block_placed: found={bname}"
            return False, f"block_placed({verify.block_x},{verify.block_y},{verify.block_z}): not found"

        else:
            return False, f"unknown_verify_type: {verify.type}"

    except Exception as e:
        return False, f"verify_exception: {e}"


def wake_steve(reason: str, step_id: int | None = None, detail: str = "") -> bool:
    """Wake Steve (MiniMax) via the bot server."""
    payload = {"type": "wake_up", "reason": reason, "step_id": step_id, "detail": detail}
    try:
        data = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(
            f"{MC_API_URL}/agent/wake",
            data=data, headers={"Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(req, timeout=5) as resp:
            return resp.status < 300
    except Exception as e:
        _log_event("wake_steve_failed", reason=reason, error=str(e))
        return False


def _build_body_session(plan: Plan, step, embodied_result: dict,
                        passed: bool, reason: str, action: str) -> dict:
    """Build structured body session summary for gateway context injection."""
    execution_results = embodied_result.get("execution_results", [])
    tool_count = len(execution_results)
    tools_ok = sum(1 for r in execution_results if r.get("ok"))
    tools_failed = tool_count - tools_ok

    tools_summary = ", ".join(
        f"{r.get('tool', '?')}: {'ok' if r.get('ok') else r.get('error_type', 'fail')}"
        for r in execution_results[:8]
    )

    return {
        "type": "body_session",
        "plan_goal": plan.goal,
        "plan_state": plan.state.value,
        "plan_progress": f"{plan.current_step}/{len(plan.steps)}",
        "step_id": step.id if step else None,
        "step_intent": (step.intent[:200] + "…") if step and len(step.intent) > 200 else (step.intent if step else None),
        "step_retries": f"{step.retries}/{step.max_retries}" if step else None,
        "gemma_ok": embodied_result.get("ok"),
        "gemma_tool_calls": tool_count,
        "gemma_tools_succeeded": tools_ok,
        "gemma_tools_failed": tools_failed,
        "execution_summary": tools_summary or "(no tool calls)",
        "gemma_elapsed_s": embodied_result.get("elapsed_seconds"),
        "verify_passed": passed,
        "verify_reason": reason,
        "action": action,
    }


def process_plan_tick(plan: Plan, now: float) -> tuple[Plan, dict]:
    """
    Execute one tick of the autonomous plan execution loop.
    Returns (updated_plan, body_session_dict).
    """
    empty_session = {"type": "body_session", "plan_state": plan.state.value, "action": "noop"}

    if plan.state == PlanState.IDLE:
        _log_event("plan_start", goal=plan.goal, steps=len(plan.steps))
        plan.state = PlanState.EXECUTING
        plan.started_at_ts = now
        plan.last_advance_ts = now
        save_plan(plan)
        return plan, {"type": "body_session", "plan_goal": plan.goal,
                      "plan_state": "executing", "plan_progress": f"0/{len(plan.steps)}",
                      "action": "plan_started"}

    if plan.state in (PlanState.COMPLETED, PlanState.ESCALATED):
        return plan, empty_session

    if plan.state == PlanState.BLOCKED:
        if plan.timed_out(now):
            _log_event("plan_timeout", goal=plan.goal, state="blocked")
            wake_steve("plan_timeout", detail=f"No advance in {plan.hard_timeout_s}s")
            plan.state = PlanState.ESCALATED
            save_plan(plan)
            return plan, {"type": "body_session", "plan_state": "escalated",
                          "action": "plan_timeout_escalated"}
        return plan, empty_session

    if plan.state != PlanState.EXECUTING:
        return plan, empty_session

    if plan.done:
        _log_event("plan_complete", goal=plan.goal, steps=len(plan.steps))
        plan.state = PlanState.COMPLETED
        save_plan(plan)
        wake_steve("plan_complete", detail=f"Goal '{plan.goal}' completed")
        return plan, {"type": "body_session", "plan_state": "completed",
                      "plan_goal": plan.goal, "action": "plan_complete"}

    if plan.timed_out(now):
        _log_event("plan_timeout", goal=plan.goal, state="executing")
        wake_steve("plan_timeout", detail=f"No advance in {plan.hard_timeout_s}s")
        plan.state = PlanState.ESCALATED
        save_plan(plan)
        return plan, {"type": "body_session", "plan_state": "escalated",
                      "action": "plan_timeout_escalated"}

    step = plan.current
    if step is None:
        plan.state = PlanState.BLOCKED
        save_plan(plan)
        return plan, empty_session

    _log_event("step_start", step_id=step.id, intent=step.intent[:120],
               retry=step.retries, max_retries=step.max_retries)

    embodied_result = call_embodied(step.intent)

    danger = _check_danger(embodied_result)
    if danger is not None:
        _log_event("danger_detected", step_id=step.id, danger=danger.value, is_critical=danger.is_critical)
        if danger.is_critical:
            plan.state = PlanState.ESCALATED
            save_plan(plan)
            wake_steve("danger_critical", step_id=step.id, detail=f"Danger: {danger.value}")
            return plan, _build_body_session(plan, step, embodied_result, False,
                                             f"danger: {danger.value}", "escalated_critical")
        wake_steve("danger_detected", step_id=step.id, detail=f"Danger: {danger.value} (non-critical)")

    passed, reason = verify_step(step, embodied_result)
    _log_event("step_verify", step_id=step.id, passed=passed, reason=reason)

    if passed:
        plan.current_step += 1
        plan.last_advance_ts = now
        step.retries = 0
        _log_event("step_advance", step_id=step.id, next_step=plan.current_step)
        if plan.done:
            plan.state = PlanState.COMPLETED
            save_plan(plan)
            wake_steve("plan_complete", detail=f"Goal '{plan.goal}' completed")
            return plan, _build_body_session(plan, step, embodied_result, True,
                                             reason, "plan_complete")
        save_plan(plan)
        return plan, _build_body_session(plan, step, embodied_result, True,
                                         reason, "step_advanced")

    step.retries += 1
    if step.exhausted:
        _log_event("step_exhausted", step_id=step.id, retries=step.retries)
        plan.state = PlanState.BLOCKED
        save_plan(plan)
        wake_steve("step_failed", step_id=step.id, detail=f"Step {step.id} exhausted: {reason}")
        return plan, _build_body_session(plan, step, embodied_result, False,
                                         reason, "step_exhausted")

    _log_event("step_retry", step_id=step.id, retries=step.retries,
               backoff=step.next_backoff_seconds, reason=reason)
    plan.last_advance_ts = now
    save_plan(plan)
    return plan, _build_body_session(plan, step, embodied_result, False,
                                     reason, "retry")


# ══════════════════════════════════════════════════════════════════════════════════════════════════════════
# WebSocket listener (activity tracking only)
# ═════════════════════════════════════════════════════════════════════════════════════════════════════════

chat_event = threading.Event()
last_chat_time = int(time.time() * 1000)
message_lock = threading.Lock()
ws_connected = threading.Event()
turn_in_progress = threading.Event()
cancel_event = threading.Event()

STANDBY_FILE = os.getenv("STANDBY_FILE", "")


def _is_standby() -> bool:
    if not STANDBY_FILE:
        return False
    return Path(STANDBY_FILE).exists()


def _refresh_standby(signum=None, frame=None):
    if not STANDBY_FILE:
        return
    sf = Path(STANDBY_FILE)
    state = "ON" if sf.exists() else "OFF"
    print(f"[loop] Standby signal — {state}", flush=True)
    chat_event.set()


signal.signal(signal.SIGUSR1, _refresh_standby)


def _ws_on_message(ws, message):
    global last_chat_time, chat_event
    try:
        data = json.loads(message)
        msg_type = data.get("type")
        if msg_type == "chat":
            msgs = data.get("data", [])
            if msgs:
                new_times = [m.get("time", 0) for m in msgs if m.get("time", 0) > last_chat_time]
                if new_times:
                    with message_lock:
                        last_chat_time = max(new_times)
        elif msg_type == "quest_event":
            chat_event.set()
        elif msg_type == "interrupt":
            chat_event.set()
        elif msg_type == "heartbeat_context":
            pass  # Echo from our own broadcast, ignore
    except Exception as e:
        print(f"[ws] Error: {e}", flush=True)


def _ws_on_open(ws):
    ws_connected.set()
    print("[ws] Connected", flush=True)


def _ws_on_close(ws, close_status_code, close_msg):
    ws_connected.clear()
    print(f"[ws] Disconnected: {close_status_code}", flush=True)


def _ws_listener():
    import websocket
    ws_url = MC_API_URL.replace("http://", "ws://").replace("https://", "wss://") + "/ws"
    while True:
        try:
            ws = websocket.WebSocketApp(
                ws_url,
                on_message=_ws_on_message,
                on_open=_ws_on_open,
                on_close=_ws_on_close,
            )
            ws.run_forever(ping_interval=30, ping_timeout=10)
        except Exception as e:
            print(f"[ws] Error: {e}. Retrying in 5s...", flush=True)
        ws_connected.clear()
        time.sleep(5)


def start_ws_listener():
    t = threading.Thread(target=_ws_listener, daemon=True)
    t.start()
    ws_connected.wait(timeout=5)


# ═════════════════════════════════════════════════════════════════════════════════════════════════════════
# Quest Engine (unchanged)
# ═════════════════════════════════════════════════════════════════════════════════════════════════════════

QUEST_ENGINE_INTERVAL = 1


def _quest_engine_loop():
    import time as _time
    import urllib.request
    from pathlib import Path

    def get_story_state():
        story_path = Path.home() / ".local" / "share" / "daemoncraft" / "rolemaster" / "story.json"
        try:
            return json.loads(story_path.read_text())
        except Exception:
            return {}

    def load_blueprint(name):
        bp_path = Path.home() / "Projects" / "DaemonCraft" / "agents" / "blueprints" / name
        try:
            return json.loads(bp_path.read_text())
        except Exception:
            return None

    def read_scoreboard(objective, player="@a"):
        import re
        import subprocess

        def _get_score(p):
            try:
                result = subprocess.run(
                    ["docker", "exec", "--user", "1000", "daemoncraft-minecraft", "rcon-cli",
                     f"scoreboard players get {p} {objective}"],
                    capture_output=True, text=True, timeout=3
                )
                match = re.search(r"has\s+(\d+)\s+\[", result.stdout)
                return int(match.group(1)) if match else 0
            except Exception:
                return 0

        try:
            if player != "@a":
                return _get_score(player)
            result = subprocess.run(
                ["docker", "exec", "--user", "1000", "daemoncraft-minecraft", "rcon-cli", "list"],
                capture_output=True, text=True, timeout=3
            )
            list_output = result.stdout.strip()
            match = re.search(r"online:\s*(.+)$", list_output)
            if not match:
                return 0
            players = [p.strip() for p in match.group(1).split(",")]
            scores = [_get_score(p) for p in players]
            return max(scores) if scores else 0
        except Exception:
            return 0

    def execute_poll_command(sensor_name, story):
        sensors = story.get("active_sensors", [])
        sensor = next((s for s in sensors if s.get("name") == sensor_name), None)
        if not sensor:
            return
        poll_cmd = sensor.get("poll_command")
        if not poll_cmd:
            return
        try:
            payload = json.dumps({"message": poll_cmd}).encode("utf-8")
            req = urllib.request.Request(
                f"{MC_API_URL}/chat/send",
                data=payload,
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            urllib.request.urlopen(req, timeout=3)
        except Exception:
            pass

    def send_quest_notify(message, event_type="phase_transition", from_phase=None, to_phase=None):
        try:
            payload = json.dumps({
                "message": message,
                "event_type": event_type,
                "from_phase": from_phase,
                "to_phase": to_phase,
            }).encode("utf-8")
            req = urllib.request.Request(
                f"{MC_API_URL}/quest/notify",
                data=payload,
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            urllib.request.urlopen(req, timeout=3)
        except Exception:
            pass

    def advance_phase_in_story(new_phase, story_path):
        try:
            story = json.loads(story_path.read_text())
            old_phase = story.get("phase")
            if old_phase == new_phase:
                return None
            story["phase"] = new_phase
            story["phase_started_at"] = int(_time.time() * 1000)
            story_path.write_text(json.dumps(story, indent=2))
            return old_phase
        except Exception:
            return None

    print("[quest_engine] Started", flush=True)

    while True:
        _time.sleep(QUEST_ENGINE_INTERVAL)
        try:
            story = get_story_state()
            if not story:
                continue

            active_bp = story.get("active_blueprint")
            current_phase = story.get("phase")
            if not active_bp or not current_phase:
                continue

            blueprint = load_blueprint(active_bp)
            if not blueprint:
                continue

            phases = blueprint.get("phases", [])
            if not phases:
                continue

            current_idx = None
            for i, ph in enumerate(phases):
                if ph.get("name") == current_phase:
                    current_idx = i
                    break

            if current_idx is None or current_idx >= len(phases) - 1:
                continue

            next_ph = phases[current_idx + 1]
            trigger = next_ph.get("trigger", {})
            if not trigger:
                continue

            trigger_type = trigger.get("type")
            triggered = False
            reason = ""

            if trigger_type == "score":
                scoreboard = trigger.get("scoreboard")
                expected = trigger.get("value", 1)
                if scoreboard:
                    execute_poll_command(scoreboard, story)
                    score = read_scoreboard(scoreboard, "@a")
                    if score >= expected:
                        triggered = True
                        reason = f"{scoreboard} = {score} (expected >= {expected})"

            elif trigger_type == "sensor":
                sensor_name = trigger.get("sensor")
                if sensor_name:
                    execute_poll_command(sensor_name, story)
                    score = read_scoreboard(sensor_name, "@a")
                    if score > 0:
                        triggered = True
                        reason = f"{sensor_name} fired (score = {score})"

            elif trigger_type == "flag":
                flag_name = trigger.get("flag")
                expected = trigger.get("value", True)
                flags = story.get("flags", {})
                if flags.get(flag_name) == expected:
                    triggered = True
                    reason = f"flag {flag_name} = {expected}"

            if triggered:
                next_phase_name = next_ph.get("name")
                story_path = Path.home() / ".local" / "share" / "daemoncraft" / "rolemaster" / "story.json"
                old_phase = advance_phase_in_story(next_phase_name, story_path)

                if old_phase:
                    msg = (
                        f"Phase transition: '{old_phase}' -> '{next_phase_name}'. "
                        f"Reason: {reason}."
                    )
                    send_quest_notify(msg, "phase_transition", old_phase, next_phase_name)
                    print(f"[quest_engine] Advanced: {old_phase} -> {next_phase_name} ({reason})", flush=True)

        except Exception as e:
            print(f"[quest_engine] Error: {e}", flush=True)


def start_quest_engine():
    t = threading.Thread(target=_quest_engine_loop, daemon=True)
    t.start()


# ═════════════════════════════════════════════════════════════════════════════════════════════════════════
# Daemon Guardian (unchanged)
# ═════════════════════════════════════════════════════════════════════════════════════════════════════════

DAEMON_GUARDIAN_INTERVAL = 5
_GODMODE_FILE = Path.home() / ".local" / "share" / "daemoncraft" / "rolemaster" / "godmode"


def _daemon_guardian_loop():
    import time as _time
    import urllib.request

    print("[daemon_guardian] Started", flush=True)

    def _godmode_enabled() -> bool:
        try:
            return _GODMODE_FILE.read_text().strip().lower() != "off"
        except Exception:
            return True

    def _bot_command(cmd: str) -> str:
        try:
            payload = json.dumps({"command": cmd}).encode("utf-8")
            req = urllib.request.Request(
                f"{MC_API_URL}/command",
                data=payload,
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=5) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                return data.get("output", "")
        except Exception:
            return ""

    def _get_bot_gamemode() -> str:
        try:
            with urllib.request.urlopen(f"{MC_API_URL}/bot/gamemode", timeout=3) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                return data.get("data", {}).get("gamemode", "unknown")
        except Exception:
            return "unknown"

    def _get_bot_effects() -> dict:
        try:
            with urllib.request.urlopen(f"{MC_API_URL}/bot/effects", timeout=3) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                return data.get("data", {})
        except Exception:
            return {}

    def _check_gamemode() -> bool:
        return _get_bot_gamemode().lower() == "creative"

    def _check_effects() -> dict:
        effects = _get_bot_effects()
        return {
            "resistance": any("resistance" in k.lower() for k in effects),
            "fire_resistance": any("fire" in k.lower() and "resistance" in k.lower() for k in effects),
            "water_breathing": any("water" in k.lower() and "breathing" in k.lower() for k in effects),
        }

    _last_applied = {"resistance": 0, "fire_resistance": 0, "water_breathing": 0, "gamemode": 0}
    _EFFECT_COOLDOWN = 60

    while True:
        _time.sleep(DAEMON_GUARDIAN_INTERVAL)
        try:
            if not _godmode_enabled():
                continue

            now = _time.time()

            if not _check_gamemode() and now - _last_applied["gamemode"] > _EFFECT_COOLDOWN:
                payload = json.dumps({"message": f"/gamemode creative {BOT_USERNAME}"}).encode("utf-8")
                req = urllib.request.Request(
                    f"{MC_API_URL}/chat/send",
                    data=payload,
                    headers={"Content-Type": "application/json"},
                    method="POST",
                )
                urllib.request.urlopen(req, timeout=3)
                _last_applied["gamemode"] = now
                print("[daemon_guardian] Restored creative mode", flush=True)

            effects = _check_effects()
            if not effects["resistance"] and now - _last_applied["resistance"] > _EFFECT_COOLDOWN:
                payload = json.dumps({
                    "message": f"/effect give {BOT_USERNAME} minecraft:resistance 999999 255 true"
                }).encode("utf-8")
                req = urllib.request.Request(
                    f"{MC_API_URL}/chat/send",
                    data=payload,
                    headers={"Content-Type": "application/json"},
                    method="POST",
                )
                urllib.request.urlopen(req, timeout=3)
                _last_applied["resistance"] = now
                print("[daemon_guardian] Applied resistance", flush=True)

            if not effects["fire_resistance"] and now - _last_applied["fire_resistance"] > _EFFECT_COOLDOWN:
                payload = json.dumps({
                    "message": f"/effect give {BOT_USERNAME} minecraft:fire_resistance 999999 0 true"
                }).encode("utf-8")
                req = urllib.request.Request(
                    f"{MC_API_URL}/chat/send",
                    data=payload,
                    headers={"Content-Type": "application/json"},
                    method="POST",
                )
                urllib.request.urlopen(req, timeout=3)
                _last_applied["fire_resistance"] = now
                print("[daemon_guardian] Applied fire_resistance", flush=True)

            if not effects["water_breathing"] and now - _last_applied["water_breathing"] > _EFFECT_COOLDOWN:
                payload = json.dumps({
                    "message": f"/effect give {BOT_USERNAME} minecraft:water_breathing 999999 0 true"
                }).encode("utf-8")
                req = urllib.request.Request(
                    f"{MC_API_URL}/chat/send",
                    data=payload,
                    headers={"Content-Type": "application/json"},
                    method="POST",
                )
                urllib.request.urlopen(req, timeout=3)
                _last_applied["water_breathing"] = now
                print("[daemon_guardian] Applied water_breathing", flush=True)

        except Exception:
            pass


def start_daemon_guardian():
    t = threading.Thread(target=_daemon_guardian_loop, daemon=True)
    t.start()


# ═════════════════════════════════════════════════════════════════════════════════════════════════════════
# Main loop — plan-driven execution + idle heartbeat
# ═════════════════════════════════════════════════════════════════════════════════════════════════════════

_IDLE_HEARTBEAT_COUNT = 0
_IDLE_HEARTBEAT_EVERY = 4  # ~28s at 7s interval


def run_agent_loop(profile_name: str, initial_prompt: str, interval: int = 7):
    """Run the agent loop. Plan-driven when active, heartbeat when idle."""
    print(f"[loop] Agent loop started: {profile_name}")
    print(f"[loop] Interval: {interval}s")
    print(f"[loop] MC_API_URL: {MC_API_URL}")
    print(f"[loop] Embodied service: {EMBODIED_SERVICE_URL}")

    start_ws_listener()
    start_quest_engine()
    if os.environ.get("DAEMON_GUARDIAN") == "1":
        start_daemon_guardian()

    turn_count = 0

    try:
        while True:
            turn_count += 1
            now = time.time()

            triggered = chat_event.wait(timeout=interval)
            chat_event.clear()

            if _is_standby():
                print("[loop] Standby — skipping turn", flush=True)
                send_agent_heartbeat(next_turn_in=interval, turn_in_progress=False)
                continue

            # ── Try autonomous plan execution first ──
            plan = load_plan()
            if plan is not None and plan.state in (PlanState.IDLE, PlanState.EXECUTING, PlanState.BLOCKED):
                global _IDLE_HEARTBEAT_COUNT
                _IDLE_HEARTBEAT_COUNT = 0

                turn_in_progress.set()
                send_agent_heartbeat(next_turn_in=None, turn_in_progress=True)

                try:
                    plan, body_session = process_plan_tick(plan, now)
                except Exception as e:
                    print(f"[loop] Plan tick error: {e}", flush=True)
                    body_session = {"type": "body_session", "action": "tick_error", "error": str(e)}
                finally:
                    turn_in_progress.clear()
                    send_agent_heartbeat(next_turn_in=interval, turn_in_progress=False)

                # Inject body session context into gateway so Steve
                # has full awareness of what the body did when woken.
                # Never mentioned in chat — internal context only.
                if body_session:
                    send_heartbeat_context({}, {}, {}, {}, [], body_session=body_session)

                # Apply backoff if current step is retrying
                if (plan.state == PlanState.EXECUTING and plan.current
                        and plan.current.retries > 0):
                    backoff = plan.current.next_backoff_seconds
                    if backoff > 0:
                        print(f"[loop] Backoff {backoff:.1f}s for step {plan.current.id}", flush=True)
                        time.sleep(backoff)

                continue

            # ── No plan (or completed/escalated) — idle heartbeat ──
            _IDLE_HEARTBEAT_COUNT += 1
            if _IDLE_HEARTBEAT_COUNT >= _IDLE_HEARTBEAT_EVERY:
                _IDLE_HEARTBEAT_COUNT = 0
                print(f"[loop] Turn {turn_count} — idle heartbeat...", flush=True)
                turn_in_progress.set()
                send_agent_heartbeat(next_turn_in=None, turn_in_progress=True)

                try:
                    status = fetch_bot_status()
                    nearby = fetch_bot_nearby()
                    inventory = fetch_bot_inventory()
                    bot_plan = fetch_plan()

                    events = []
                    if triggered:
                        events.append("Chat or quest activity detected")

                    ok = send_heartbeat_context(status, nearby, inventory, bot_plan, events)
                    if ok:
                        print(f"[loop] Idle heartbeat sent", flush=True)
                        _emit_metric("heartbeat", triggered=bool(triggered))
                    else:
                        print("[loop] Idle heartbeat send failed", flush=True)

                except Exception as e:
                    print(f"[loop] Idle heartbeat error: {e}", flush=True)
                finally:
                    turn_in_progress.clear()
                    send_agent_heartbeat(next_turn_in=interval, turn_in_progress=False)

    except KeyboardInterrupt:
        print("[loop] Interrupted. Exiting.")


def main():
    parser = argparse.ArgumentParser(description="DaemonCraft heartbeat injector")
    parser.add_argument("--profile", default="", help="Agent name (for logging)")
    parser.add_argument("--prompt", default="Begin.", help="Unused legacy arg")
    parser.add_argument("--interval", type=int, default=30, help="Seconds between heartbeats")
    args = parser.parse_args()

    run_agent_loop(args.profile, args.prompt, args.interval)


if __name__ == "__main__":
    main()
