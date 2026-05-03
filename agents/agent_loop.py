#!/usr/bin/env python3
"""
Hermes-native persistent agent loop for Minecraft bots — HEARTBEAT INJECTOR ONLY.

DC-112 Architecture: The gateway owns all cognition (single AIAgent session).
The agent_loop's sole job is to poll sensors every 30s and inject heartbeat
context into the gateway via the bot server's WebSocket.

Usage:
    python agent_loop.py --profile stevie --interval 30
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

MC_API_URL = os.getenv("MC_API_URL", "http://localhost:3001")
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


def send_heartbeat_context(status: dict, nearby: dict, inventory: dict, plan: dict, events: list) -> bool:
    """Send a perception snapshot to the gateway via the bot server."""
    return _post_json("/heartbeat/context", {
        "status": status,
        "nearby": nearby,
        "inventory": inventory,
        "plan": plan,
        "events": events,
    })


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
# Main loop — HEARTBEAT INJECTOR ONLY
# ═════════════════════════════════════════════════════════════════════════════════════════════════════════

def run_agent_loop(profile_name: str, initial_prompt: str, interval: int = 30):
    """Run the heartbeat injector loop. No AIAgent — the gateway owns cognition."""
    print(f"[loop] Heartbeat injector started: {profile_name}")
    print(f"[loop] Interval: {interval}s")
    print(f"[loop] MC_API_URL: {MC_API_URL}")

    start_ws_listener()
    start_quest_engine()
    if os.environ.get("DAEMON_GUARDIAN") == "1":
        start_daemon_guardian()

    turn_count = 0

    try:
        while True:
            turn_count += 1

            triggered = chat_event.wait(timeout=interval)
            chat_event.clear()

            if _is_standby():
                print("[loop] Standby — skipping heartbeat", flush=True)
                send_agent_heartbeat(next_turn_in=interval, turn_in_progress=False)
                continue

            # Pause check — dashboard can pause heartbeat context without restarting service
            try:
                with urllib.request.urlopen(f"{MC_API_URL}/agent/paused", timeout=2) as _pr:
                    if json.loads(_pr.read().decode()).get("paused"):
                        print("[loop] Paused by dashboard — skipping turn", flush=True)
                        send_agent_heartbeat(next_turn_in=None, turn_in_progress=False)
                        continue
            except Exception:
                pass

            # Gather world state
            print(f"[loop] Turn {turn_count} — gathering state...", flush=True)
            turn_in_progress.set()
            send_agent_heartbeat(next_turn_in=None, turn_in_progress=True)

            try:
                status = fetch_bot_status()
                nearby = fetch_bot_nearby()
                inventory = fetch_bot_inventory()
                plan = fetch_plan()

                # Build events list from recent activity
                events = []
                if triggered:
                    events.append("Chat or quest activity detected")

                # Send heartbeat context to gateway
                ok = send_heartbeat_context(status, nearby, inventory, plan, events)
                if ok:
                    print(f"[loop] Heartbeat sent (status={bool(status)}, nearby={bool(nearby)}, plan={bool(plan)})", flush=True)
                    _emit_metric("heartbeat", triggered=bool(triggered))
                else:
                    print("[loop] Heartbeat send failed", flush=True)

            except Exception as e:
                print(f"[loop] Error gathering state: {e}", flush=True)
            finally:
                turn_in_progress.clear()
                send_agent_heartbeat(next_turn_in=interval, turn_in_progress=False)

    except KeyboardInterrupt:
        print("[loop] Interrupted. Exiting.")


def main():
    parser = argparse.ArgumentParser(description="DaemonCraft heartbeat injector")
    parser.add_argument("--profile", required=True, help="Hermes profile name")
    parser.add_argument("--prompt", default="Begin.", help="Unused legacy arg")
    parser.add_argument("--interval", type=int, default=30, help="Seconds between heartbeats")
    args = parser.parse_args()

    run_agent_loop(args.profile, args.prompt, args.interval)


if __name__ == "__main__":
    main()
