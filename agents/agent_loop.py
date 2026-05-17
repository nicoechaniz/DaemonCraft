#!/usr/bin/env python3
"""
DaemonCraft agent loop -- Canonical Heartbeat + Guardian.

Simplified loop that replaces the old plan-based architecture with:

  1. HEARTBEAT -- gathers world state and sends to Hermes gateway every ~30s.
  2. GUARDIAN -- monitors bot health/hazards every tick, sends emergency
     heartbeat if critical danger detected.
  3. IDLE -- when nothing is happening, waits for chat events or ticks.

Steve (Hermes cloud LLM) is the captain. This loop is the crew:
it keeps the ship alive and reports status. Steve decides.

No persistent plans. No daemon guardian effects. No wake_steve HTTP endpoint.
Alerts go via emergency heartbeat context.
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

# Import plan schema from same directory (Autonomia Corporal)
_AGENTS_DIR = Path(__file__).resolve().parent
if str(_AGENTS_DIR) not in sys.path:
    sys.path.insert(0, str(_AGENTS_DIR))

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
# Singleton Session — Context Stream + Event Queue
# ══════════════════════════════════════════════════════════════════════════════════════════════════════════

_SESSION_DIR = Path.home() / ".hermes" / "sessions"
_STREAM_FILE = _SESSION_DIR / "daemoncraft-stream.json"
_EVENTS_FILE = _SESSION_DIR / "daemoncraft-events.jsonl"
_EVENTS_PROCESSING = _SESSION_DIR / "daemoncraft-events.processing"
_STREAM_TMP = _SESSION_DIR / "daemoncraft-stream.tmp"

_SESSION_DIR.mkdir(parents=True, exist_ok=True)


def export_context_stream(status: dict, nearby: dict, inventory: dict,
                          bot_plan: dict = None, last_chat: list = None,
                          errors: list = None, events_consumed: int = 0,
                          tick: int = 0, session_id: str = "daemoncraft-singleton"):
    """Export current bot state to daemoncraft-stream.json via atomic rename."""
    try:
        payload = {
            "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "tick": tick,
            "session_id": session_id,
            "bot": {
                "health": status.get("health"),
                "max_health": status.get("maxHealth"),
                "food": status.get("food"),
                "position": status.get("position"),
                "holding": status.get("holding"),
                "on_ground": status.get("onGround"),
                "is_in_water": status.get("isInWater"),
                "dimension": status.get("dimension"),
                "is_day": status.get("isDay"),
            },
            "nearby": {
                "entities": nearby.get("entities") or status.get("nearbyEntities", []),
                "blocks": nearby.get("blocks") or status.get("nearbyBlocks", []),
            },
            "inventory": inventory,
            "plan": bot_plan,
            "last_action": status.get("task"),
            "last_chat": last_chat or status.get("unreadChat", []),
            "errors": errors or [],
            "events_consumed": events_consumed,
        }
        _STREAM_TMP.write_text(json.dumps(payload, indent=2))
        _STREAM_TMP.rename(_STREAM_FILE)
    except Exception as e:
        print(f"[loop] Context stream export failed: {e}", flush=True)


def read_and_clear_event_queue() -> list[dict]:
    """Read and clear the event queue atomically. Returns list of event dicts."""
    if not _EVENTS_FILE.exists():
        return []
    try:
        # Atomic claim: rename to processing file
        _EVENTS_FILE.rename(_EVENTS_PROCESSING)
        events = []
        for line in _EVENTS_PROCESSING.read_text().strip().split("\n"):
            if line.strip():
                try:
                    events.append(json.loads(line))
                except json.JSONDecodeError:
                    pass
        _EVENTS_PROCESSING.unlink(missing_ok=True)
        return events
    except FileNotFoundError:
        # Already claimed by another process (unlikely in single-writer model)
        return []
    except Exception as e:
        print(f"[loop] Event queue read error: {e}", flush=True)
        # Recover: if processing file exists, try to read it
        if _EVENTS_PROCESSING.exists():
            try:
                events = []
                for line in _EVENTS_PROCESSING.read_text().strip().split("\n"):
                    if line.strip():
                        try:
                            events.append(json.loads(line))
                        except json.JSONDecodeError:
                            pass
                _EVENTS_PROCESSING.unlink(missing_ok=True)
                return events
            except Exception:
                pass
        return []


def format_events_for_injection(events: list[dict]) -> str:
    """Format event queue entries as context for the inner session."""
    if not events:
        return ""
    lines = ["External events since last tick:"]
    for e in events:
        ev_type = e.get("event", "unknown")
        src = e.get("src", "unknown")
        if ev_type == "tool_called":
            lines.append(f"- CLI called {e.get('tool', '?')}: {e.get('cmd', '?')}")
        elif ev_type == "world_change":
            lines.append(f"- World changed: {e.get('note', '?')}")
        elif ev_type == "code_changed":
            lines.append(f"- Code updated: {e.get('commit', '?')} — {e.get('note', '?')}")
        elif ev_type == "message":
            lines.append(f"- Message from dev session: {e.get('text', '?')}")
        else:
            lines.append(f"- [{src}] {ev_type}: {json.dumps(e)}")
    lines.append("")
    return "\n".join(lines)

_MAX_EMBODIED_RETRIES = 3
_EMBODIED_BACKOFF_BASE = 2.0


def _log_event(event: str, **fields) -> None:
    """Emit a structured JSON log line."""
    record = {"ts": time.time(), "bot": BOT_USERNAME, "event": event, **fields}
    print(json.dumps(record, separators=(",", ":")), flush=True)




def check_hazards(status: dict) -> str | None:
    """Check for critical hazards in bot status that require immediate attention."""
    if not status:
        return None
    
    health = status.get("health", 20)
    max_health = status.get("maxHealth", 20)
    
    # Critical health
    if health < 5:
        return f"Health critical: {health}/{max_health}"
    
    # Scene hazards (lava, fire) — array of strings like "lava northeast 5m"
    scene = status.get("scene", {})
    hazard_strings = scene.get("hazards", [])
    if hazard_strings:
        for h in hazard_strings:
            h_lower = h.lower()
            if "lava" in h_lower:
                return f"Lava detected: {h}"
            if "fire" in h_lower:
                return f"Fire detected: {h}"
    
    # Drowning — isInWater was added to getFullState
    if status.get("isInWater"):
        return "Bot is submerged in water — drowning risk"
    
    # Hostile mobs from nearbyEntities
    nearby_entities = status.get("nearbyEntities", [])
    hostile_types = ["zombie", "skeleton", "creeper", "spider", "enderman", "witch", "husk", "drowned", "phantom"]
    for entity in nearby_entities:
        entity_type = (entity.get("type") or "").lower()
        if any(hostile in entity_type for hostile in hostile_types):
            dist = entity.get("distance", "?")
            return f"Hostile mob detected: {entity.get('type')} at {dist}m"
    
    return None


# ═════════════════════════════════════════════════════════════════════════════════════════════════════════
# Heartbeat loop
# ═════════════════════════════════════════════════════════════════════════════════════════════════════════

_IDLE_HEARTBEAT_COUNT = 0
_IDLE_HEARTBEAT_EVERY = 4  # ~28s at 7s interval
_LAST_HAZARD_ALERT = {}     # hazard_type -> timestamp (cooldown for wake_steve)
_HAZARD_COOLDOWN_S = 30


def wake_steve(reason: str, detail: str = "") -> bool:
    """Alert Steve (Hermes agent) by sending an emergency heartbeat with the alert.
    
    Cooldown: same hazard type is not repeated within _HAZARD_COOLDOWN_S seconds.
    """
    now = time.time()
    hazard_key = reason.lower().replace(" ", "_")
    last_alert = _LAST_HAZARD_ALERT.get(hazard_key, 0)
    if now - last_alert < _HAZARD_COOLDOWN_S:
        return True  # Suppressed by cooldown
    
    try:
        status = fetch_bot_status()
        nearby = fetch_bot_nearby()
        inventory = fetch_bot_inventory()
        alert = f"ALERT: {reason}. {detail}".strip()
        events = [alert]
        ok = send_heartbeat_context(status, nearby, inventory, {}, events)
        if ok:
            _LAST_HAZARD_ALERT[hazard_key] = now
        _log_event("wake_steve_sent", reason=reason, detail=detail, ok=ok)
        return ok
    except Exception as e:
        _log_event("wake_steve_failed", reason=reason, error=str(e))
        return False


def call_embodied(intent: str, deadline_s: int = 20, previous_error: dict | None = None) -> dict:
    """Call POST /intent on the embodied service. Retries with backoff."""
    last_error = None
    for attempt in range(_MAX_EMBODIED_RETRIES + 1):
        payload = {"intent": intent, "deadline_seconds": deadline_s}
        if previous_error:
            payload["previous_error"] = previous_error
        payload_bytes = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(
            f"{EMBODIED_SERVICE_URL}/intent",
            data=payload_bytes,
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


def fetch_plan() -> dict:
    """Fetch the bot's current task from /status (legacy /plan endpoint removed)."""
    try:
        status = fetch_bot_status()
        task = status.get("task")
        if task:
            return {"goal": task.get("action", ""), "state": task.get("status", "idle"), "current_step": 0}
        return {}
    except Exception:
        return {}


chat_event = threading.Event()
last_chat_time = int(time.time() * 1000)
message_lock = threading.Lock()
ws_connected = threading.Event()
turn_in_progress = threading.Event()

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

    turn_count = 0

    try:
        while True:
            global _IDLE_HEARTBEAT_COUNT
            turn_count += 1
            now = time.time()

            triggered = chat_event.wait(timeout=interval)
            chat_event.clear()

            if _is_standby():
                print("[loop] Standby — skipping turn", flush=True)
                send_agent_heartbeat(next_turn_in=interval, turn_in_progress=False)
                continue

            # ── Guardian: check hazards every tick ──
            try:
                status = fetch_bot_status()
                hazard = check_hazards(status)
                if hazard:
                    print(f"[loop] HAZARD DETECTED: {hazard}", flush=True)
                    wake_steve("hazard_critical", detail=hazard)
                    send_agent_heartbeat(next_turn_in=interval, turn_in_progress=False)
                    continue
            except Exception as e:
                print(f"[loop] Hazard check error: {e}", flush=True)

            # ── Periodic heartbeat ──
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

                    # Singleton Session: read event queue
                    events_raw = read_and_clear_event_queue()
                    events_context = format_events_for_injection(events_raw)
                    if events_context:
                        print(f"[loop] Consumed {len(events_raw)} external events", flush=True)

                    # Singleton Session: export context stream
                    export_context_stream(
                        status=status, nearby=nearby, inventory=inventory,
                        bot_plan=bot_plan,
                        events_consumed=len(events_raw),
                        tick=turn_count,
                    )

                    events = []
                    if triggered:
                        events.append("Chat or quest activity detected")

                    # Compose minimal body_session so Steve knows what the body is doing
                    task = status.get("task")
                    body_session = {
                        "mode": task.get("status") if task else "idle",
                        "last_action": task.get("action") if task else None,
                        "position": status.get("position"),
                        "health": status.get("health"),
                        "holding": status.get("holding"),
                        "on_ground": status.get("onGround"),
                    }

                    ok = send_heartbeat_context(status, nearby, inventory, bot_plan, events, body_session=body_session)
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
