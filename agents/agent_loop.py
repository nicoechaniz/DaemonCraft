#!/usr/bin/env python3
"""
Hermes-native persistent agent loop for Minecraft bots.

Event-driven: chat messages arrive via WebSocket and trigger turns immediately.
Idle heartbeat runs every 30s when no chat activity.

Usage:
    python agent_loop.py --profile stevie --prompt "Begin."
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

from run_agent import AIAgent

MC_API_URL = os.getenv("MC_API_URL", "http://localhost:3001")
BOT_USERNAME = os.getenv("MC_USERNAME", "Steve").lower()
# Comma-separated list of bot usernames (e.g., "eko,pamplinas,steve")
# Used to identify bot-to-bot messages and prevent cross-bot interruptions.
KNOWN_BOTS = set(
    u.strip().lower()
    for u in os.getenv("MC_KNOWN_BOTS", BOT_USERNAME).split(",")
    if u.strip()
)


# ═══════════════════════════════════════════════════════════════════════════════
# Module-level helpers (safe to call from threads)
# ═══════════════════════════════════════════════════════════════════════════════

def log_agent_turn(turn_data: dict):
    """Send turn data to bot server for dashboard display."""
    payload = json.dumps(turn_data).encode("utf-8")
    req = urllib.request.Request(
        f"{MC_API_URL}/agent/log",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            pass
    except Exception:
        pass


def send_heartbeat(next_turn_in: float | None = None, turn_in_progress: bool = False):
    """Send heartbeat countdown to bot server for dashboard display."""
    payload = json.dumps({
        "nextTurnIn": next_turn_in,
        "turnInProgress": turn_in_progress,
    }).encode("utf-8")
    req = urllib.request.Request(
        f"{MC_API_URL}/agent/heartbeat",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=2) as resp:
            pass
    except Exception:
        pass


def _clean_response_for_chat(text: str) -> str:
    """Best-effort cleanup. Currently a no-op; reserved for future tag stripping."""
    if not text:
        return ""
    return text.strip()


def _post_chat(text: str) -> None:
    """Hand the full text to the bot server. Server does chunking + delivery.

    No pre-chunking, no length filtering, no SAY: parsing. The server is the
    sole authority on what reaches Minecraft.
    """
    text = _clean_response_for_chat(text)
    if not text:
        return
    payload = json.dumps({"message": text}).encode("utf-8")
    req = urllib.request.Request(
        f"{MC_API_URL}/chat/send",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            sent = data.get("fragments_sent", 0)
            dropped = data.get("fragments_dropped", 0)
            if dropped:
                print(f"[loop] Chat: {sent} fragments sent, {dropped} dropped (cap)", flush=True)
    except Exception as e:
        print(f"[loop] /chat/send failed: {e}", flush=True)


def _safe_trim_history(messages: list, max_msgs: int = 20) -> list:
    """Trim conversation history without breaking tool_call chains.

    If a tool result message is kept, its parent assistant message (containing
    the matching tool_call) must also be kept. Otherwise tool_call_id refs
    become orphaned and the API rejects with 400.
    """
    if len(messages) <= max_msgs:
        return messages

    keep_from = len(messages) - max_msgs

    # Collect all tool_call_ids from tool messages inside the proposed window
    tool_ids_in_window = set()
    for msg in messages[keep_from:]:
        if msg.get("role") == "tool" and msg.get("tool_call_id"):
            tool_ids_in_window.add(msg["tool_call_id"])

    # Ensure every assistant that owns those tool_calls is also in the window
    for i, msg in enumerate(messages):
        if msg.get("role") == "assistant" and msg.get("tool_calls"):
            for tc in msg["tool_calls"]:
                tc_id = tc.get("id")
                if tc_id and tc_id in tool_ids_in_window:
                    keep_from = min(keep_from, i)

    return messages[keep_from:]


# ═══════════════════════════════════════════════════════════════════════════════
# Plan helpers
# ═══════════════════════════════════════════════════════════════════════════════

def fetch_plan() -> dict:
    """Fetch the bot's current plan from the bot server."""
    try:
        with urllib.request.urlopen(f"{MC_API_URL}/plan", timeout=5) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            return data.get("data", {})
    except Exception:
        return {}


def format_plan(plan: dict) -> str:
    """Format the plan as a string to inject into the prompt."""
    if not plan or not plan.get("goal"):
        return ""
    goal = plan.get("goal", "")
    tasks = plan.get("tasks", [])
    done = sum(1 for t in tasks if t.get("status") == "done")
    total = len(tasks)

    if total > 0 and done == total:
        return (
            f"Your goal '{goal}' is COMPLETE. All {total} tasks finished.\n"
            f"Announce your success to the player with mc_chat, then EITHER:\n"
            f"  1. Ask what they'd like you to work on next\n"
            f"  2. Set your own goal based on what would be useful (check status, inventory, surroundings)\n"
            f"If you choose option 2, use mc_plan(action='set_goal', goal='...', tasks=[...]) to commit.\n"
        )

    lines = [
        f"Your current goal: {goal}",
        f"Task progress: {done}/{total} done",
    ]
    for i, t in enumerate(tasks):
        sym = {
            "done": "[x]",
            "in_progress": "[->]",
            "blocked": "[!]",
        }.get(t.get("status", ""), "[ ]")
        desc = t.get("description", "")
        att = f" (attempt {t.get('attempts', 0)})" if t.get("attempts") else ""
        lines.append(f"  {sym} {i + 1}. {desc}{att}")
    return "\n".join(lines)


def load_profile_config(profile_name: str) -> dict:
    """Load config from a Hermes profile directory."""
    from hermes_cli.profiles import get_profile_dir, profile_exists

    if not profile_exists(profile_name):
        raise ValueError(f"Profile '{profile_name}' does not exist")

    profile_dir = get_profile_dir(profile_name)
    config_path = profile_dir / "config.yaml"

    # Load profile .env so credentials (MINIMAX_API_KEY, etc.) are available
    env_path = profile_dir / ".env"
    if env_path.exists():
        for line in env_path.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if "=" in line:
                key, value = line.split("=", 1)
                os.environ[key.strip()] = value.strip().strip('"').strip("'")
                print(f"[loop] Loaded env: {key.strip()}")

    config = {}
    if config_path.exists():
        import yaml
        config = yaml.safe_load(config_path.read_text()) or {}

    return config, profile_dir


def build_system_prompt(profile_dir: Path) -> str:
    """Build system prompt from SOUL.md and other context files."""
    parts = []

    soul = profile_dir / "SOUL.md"
    if soul.exists():
        parts.append(soul.read_text())

    for name in ("AGENTS.md", ".cursorrules"):
        f = profile_dir / name
        if f.exists():
            parts.append(f.read_text())

    return "\n\n".join(parts) if parts else None


# ═══════════════════════════════════════════════════════════════════════════════
# WebSocket chat trigger
# ═══════════════════════════════════════════════════════════════════════════════

chat_event = threading.Event()
pending_messages = []
message_lock = threading.Lock()
last_chat_time = int(time.time() * 1000)
ws_connected = threading.Event()
turn_in_progress = threading.Event()
current_agent = None
next_turn_time = None
countdown_lock = threading.Lock()
cancel_event = threading.Event()

# ── Standby mode ───────────────────────────────────────────────────────────────
# When standby is enabled, the bot stays connected to Minecraft but skips
# autonomous turns (heartbeat). It only responds to player chat messages.
# Controlled via STANDBY_FILE (touched by daemoncraft.py pause/resume).
STANDBY_FILE = os.getenv("STANDBY_FILE", "")


def _is_standby() -> bool:
    if not STANDBY_FILE:
        return False
    return Path(STANDBY_FILE).exists()


def _refresh_standby(signum=None, frame=None):
    """SIGUSR1 handler — wakes the main loop so it re-reads the standby file immediately.
    The control file is the source of truth; we do NOT toggle it here (daemoncraft.py manages it)."""
    if not STANDBY_FILE:
        return
    sf = Path(STANDBY_FILE)
    state = "ON" if sf.exists() else "OFF"
    print(f"[loop] Standby signal received — standby is {state}", flush=True)
    # Wake the main loop so it notices the change immediately
    chat_event.set()


# Wire SIGUSR1 for instant refresh
signal.signal(signal.SIGUSR1, _refresh_standby)


def _wire_tool_cancel_event(event) -> bool:
    """Find the minecraft_tools module (loaded by Hermes) and wire the cancel event."""
    for mod_name in ("tools.minecraft_tools", "minecraft_tools", "hermescraft.minecraft_tools"):
        mod = sys.modules.get(mod_name)
        if mod and hasattr(mod, "set_cancel_event"):
            mod.set_cancel_event(event)
            print(f"[loop] Wired cancel event into {mod_name}", flush=True)
            return True
    return False


def _ws_on_message(ws, message):
    global last_chat_time, pending_messages, chat_event
    try:
        data = json.loads(message)
        msg_type = data.get("type")
        if msg_type == "chat":
            msgs = data.get("data", [])
            new_msgs = [
                m for m in msgs
                if m.get("time", 0) > last_chat_time
                and m.get("from", "").lower() != BOT_USERNAME
            ]
            if new_msgs:
                # Classify messages: urgent (@mention from human) vs normal (everything else)
                # Also filter: bot messages without @mention are silently dropped entirely.
                urgent_msgs = []
                accepted_msgs = []
                for m in new_msgs:
                    from_user = m.get("from", "").lower()
                    msg_text = m.get("message", "")
                    is_bot = from_user in KNOWN_BOTS
                    mentions_bot = f"@{BOT_USERNAME.lower()}" in msg_text.lower()
                    
                    # Bots only get a response if they @mention us. Humans always get a response.
                    if is_bot and not mentions_bot:
                        continue  # Silently drop bot spam that doesn't mention us
                    
                    accepted_msgs.append(m)
                    
                    # Only humans can interrupt with @mention. Bots never interrupt,
                    # even if they @mention each other.
                    if mentions_bot and not is_bot:
                        urgent_msgs.append(m)

                with message_lock:
                    pending_messages.extend(accepted_msgs)
                    last_chat_time = max(m.get("time", 0) for m in new_msgs)
                chat_event.set()

                # Interrupt ONLY for urgent human @mentions
                if urgent_msgs and turn_in_progress.is_set() and current_agent is not None:
                    try:
                        cancel_event.set()
                        current_agent._interrupt_requested = True
                        senders = ", ".join({m.get("from", "Player") for m in urgent_msgs})
                        print(f"[ws] Urgent @mention from {senders} — interrupting to respond now", flush=True)
                    except Exception:
                        pass
                elif accepted_msgs:
                    senders = ", ".join({m.get("from", "Player") for m in accepted_msgs})
                    print(f"[ws] Chat from {senders} queued — will respond after current action", flush=True)
                elif new_msgs:
                    # All messages were bot spam without @mention
                    print(f"[ws] Ignored {len(new_msgs)} bot message(s) without @mention", flush=True)
        elif msg_type == "blueprint_updated":
            bp_name = data.get("data", {}).get("name", "unknown")
            with message_lock:
                pending_messages.append({
                    "from": "Dashboard",
                    "message": f"Blueprint '{bp_name}' was updated via the dashboard. Run mc_story(action='load_blueprint', name='{bp_name}') to reload the latest version.",
                    "time": int(time.time() * 1000),
                })
            chat_event.set()
        elif msg_type == "quest_event":
            event_data = data.get("data", {})
            with message_lock:
                pending_messages.append({
                    "from": "QuestEngine",
                    "message": event_data.get("message", "A quest event occurred."),
                    "time": int(time.time() * 1000),
                })
            chat_event.set()
            # Quest events can still interrupt (they are system-generated, not chat)
            if turn_in_progress.is_set() and current_agent is not None:
                try:
                    cancel_event.set()
                    current_agent._interrupt_requested = True
                    print("[ws] Quest event arrived during turn — interrupting to respond now", flush=True)
                except Exception:
                    pass
        elif msg_type == "status":
            pass
        else:
            pass
    except Exception as e:
        print(f"[ws] Error: {e}", flush=True)


def _ws_on_open(ws):
    ws_connected.set()
    print("[ws] Connected to bot WebSocket", flush=True)


def _ws_on_close(ws, close_status_code, close_msg):
    ws_connected.clear()
    print(f"[ws] Disconnected: {close_status_code} {close_msg}", flush=True)


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
            print(f"[ws] Connection error: {e}. Retrying in 5s...", flush=True)
        ws_connected.clear()
        time.sleep(5)


def start_ws_listener():
    t = threading.Thread(target=_ws_listener, daemon=True)
    t.start()
    ws_connected.wait(timeout=5)


# ═══════════════════════════════════════════════════════════════════════════════
# Countdown timer
# ═══════════════════════════════════════════════════════════════════════════════

def _countdown_timer(interval: int):
    print("[loop] Countdown timer started", flush=True)
    while True:
        try:
            time.sleep(5)
            with countdown_lock:
                target = next_turn_time
            in_progress = turn_in_progress.is_set()
            if target is None:
                if in_progress:
                    send_heartbeat(next_turn_in=None, turn_in_progress=True)
                else:
                    send_heartbeat(next_turn_in=None, turn_in_progress=False)
                continue
            remaining = target - time.time()
            if remaining > 0 and not in_progress:
                print(f"[loop] Next turn in {int(remaining)}s...", flush=True)
                send_heartbeat(next_turn_in=remaining, turn_in_progress=False)
            elif in_progress:
                send_heartbeat(next_turn_in=None, turn_in_progress=True)
            else:
                print("[loop] Turn starting now...", flush=True)
                send_heartbeat(next_turn_in=0, turn_in_progress=False)
        except Exception as e:
            print(f"[loop] Countdown thread error: {e}", flush=True)
            time.sleep(5)


def start_countdown(interval: int):
    t = threading.Thread(target=_countdown_timer, args=(interval,), daemon=True)
    t.start()


# ═══════════════════════════════════════════════════════════════════════════════
# QuestEngine — background sensor polling + auto phase advancement
# ═══════════════════════════════════════════════════════════════════════════════

QUEST_ENGINE_INTERVAL = 1  # seconds between polls


def _quest_engine_loop():
    """Background thread that polls sensors and auto-advances quest phases.

    Flow:
      1. Read story.json → get active blueprint + current phase
      2. Read blueprint JSON → find current phase + next phase
      3. Evaluate next phase's trigger condition
      4. If triggered: advance phase in story.json + notify Pamplinas via /quest/notify
    """
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
        """Read scoreboard via RCON. If player is '@a', query all online players and return max score."""
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

            # Get online players from /list
            result = subprocess.run(
                ["docker", "exec", "--user", "1000", "daemoncraft-minecraft", "rcon-cli", "list"],
                capture_output=True, text=True, timeout=3
            )
            list_output = result.stdout.strip()
            # Parse: "There are N of a max of M players online: player1, player2"
            match = re.search(r"online:\s*(.+)$", list_output)
            if not match:
                return 0
            players = [p.strip() for p in match.group(1).split(",")]
            scores = [_get_score(p) for p in players]
            return max(scores) if scores else 0
        except Exception:
            return 0

    def execute_poll_command(sensor_name, story):
        """Execute poll_command for a dummy sensor before reading its score."""
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
        except Exception as e:
            print(f"[quest_engine] Notify failed: {e}", flush=True)

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

    print("[quest_engine] Background thread started", flush=True)

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

            # Find current phase index
            current_idx = None
            for i, ph in enumerate(phases):
                if ph.get("name") == current_phase:
                    current_idx = i
                    break

            if current_idx is None or current_idx >= len(phases) - 1:
                continue  # Last phase or not found

            # Evaluate next phase trigger
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
                        f"Reason: {reason}. "
                        f"Please narrate this transition to the players."
                    )
                    send_quest_notify(msg, "phase_transition", old_phase, next_phase_name)
                    print(
                        f"[quest_engine] Advanced: {old_phase} -> {next_phase_name} ({reason})",
                        flush=True,
                    )

        except Exception as e:
            print(f"[quest_engine] Error: {e}", flush=True)


def start_quest_engine():
    t = threading.Thread(target=_quest_engine_loop, daemon=True)
    t.start()

# ═══════════════════════════════════════════════════════════════════════════════════════════════
# Daemon Guardian — keep Pamplinas in creative + invulnerable
# ═══════════════════════════════════════════════════════════════════════════════════════════════

DAEMON_GUARDIAN_INTERVAL = 5  # seconds
_GODMODE_FILE = Path.home() / ".local" / "share" / "daemoncraft" / "rolemaster" / "godmode"


def _daemon_guardian_loop():
    """Background thread that keeps the bot in creative mode and invulnerable.

    Pamplinas is a Daemon — he does not walk, he does not drown, he does not die.
    If the server, a plugin, or a bug switches him to survival, this guardian
    immediately switches him back.

    Respects the godmode state file:
      - "on"  (default) → guardian is active
      - "off" → guardian sleeps, allowing manual survival/testing
    """
    import time as _time
    import urllib.request

    print("[daemon_guardian] Background thread started", flush=True)

    def _godmode_enabled() -> bool:
        try:
            return _GODMODE_FILE.read_text().strip().lower() != "off"
        except Exception:
            return True  # default ON

    def _bot_command(cmd: str) -> str:
        """Execute a command as the bot and return the server response."""
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
        """Query the bot's current gamemode via the bot API."""
        try:
            with urllib.request.urlopen(f"{MC_API_URL}/bot/gamemode", timeout=3) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                return data.get("data", {}).get("gamemode", "unknown")
        except Exception:
            return "unknown"

    def _get_bot_effects() -> dict:
        """Query the bot's active effects via the bot API."""
        try:
            with urllib.request.urlopen(f"{MC_API_URL}/bot/effects", timeout=3) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                return data.get("data", {})
        except Exception:
            return {}

    def _check_gamemode() -> bool:
        """Returns True if already in creative mode."""
        return _get_bot_gamemode().lower() == "creative"

    def _check_effects() -> dict:
        """Returns which guardian effects are currently active."""
        effects = _get_bot_effects()
        return {
            "resistance": any("resistance" in k.lower() for k in effects),
            "fire_resistance": any("fire" in k.lower() and "resistance" in k.lower() for k in effects),
            "water_breathing": any("water" in k.lower() and "breathing" in k.lower() for k in effects),
        }

    while True:
        _time.sleep(DAEMON_GUARDIAN_INTERVAL)
        try:
            if not _godmode_enabled():
                continue

            # Enforce creative mode ONLY if not already creative
            if not _check_gamemode():
                payload = json.dumps({"message": f"/gamemode creative {BOT_USERNAME}"}).encode("utf-8")
                req = urllib.request.Request(
                    f"{MC_API_URL}/chat/send",
                    data=payload,
                    headers={"Content-Type": "application/json"},
                    method="POST",
                )
                urllib.request.urlopen(req, timeout=3)
                print("[daemon_guardian] Restored creative mode", flush=True)

            # Check which effects are missing, apply only those
            effects = _check_effects()
            if not effects["resistance"]:
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
                print("[daemon_guardian] Applied resistance", flush=True)

            if not effects["fire_resistance"]:
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
                print("[daemon_guardian] Applied fire_resistance", flush=True)

            if not effects["water_breathing"]:
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
                print("[daemon_guardian] Applied water_breathing", flush=True)

        except Exception:
            pass


def start_daemon_guardian():
    t = threading.Thread(target=_daemon_guardian_loop, daemon=True)
    t.start()



# ═══════════════════════════════════════════════════════════════════════════════
# Main loop
# ═══════════════════════════════════════════════════════════════════════════════

def run_agent_loop(profile_name: str, initial_prompt: str, interval: int = 30):
    """Run an AIAgent in a persistent event-driven loop."""
    config, profile_dir = load_profile_config(profile_name)

    model_cfg = config.get("model", {})
    if isinstance(model_cfg, dict):
        model = model_cfg.get("default", "")
    else:
        model = str(model_cfg)

    provider = None
    base_url = None
    providers = config.get("providers", {})
    if providers and isinstance(providers, dict):
        first_key = next(iter(providers))
        pcfg = providers[first_key]
        if isinstance(pcfg, dict):
            provider = pcfg.get("provider") or first_key
            base_url = pcfg.get("base_url")

    toolsets = config.get("toolsets", [])
    if not toolsets:
        toolsets = config.get("platform_toolsets", {}).get("cli", [])

    system_prompt = build_system_prompt(profile_dir)
    mc_api_url = os.getenv("MC_API_URL", "")

    print(f"[loop] Starting persistent agent: {profile_name}")
    print(f"[loop] Model: {model}")
    print(f"[loop] Provider: {provider}")
    print(f"[loop] Base URL: {base_url}")
    print(f"[loop] Toolsets: {toolsets}")
    print(f"[loop] MC_API_URL: {mc_api_url}")
    print(f"[loop] Interval: {interval}s")

    # Force Anthropic Messages API for MiniMax anthropic endpoints
    # so prompt caching and native Anthropic features work.
    api_mode = None
    if provider == "minimax" and base_url and base_url.rstrip("/").endswith("/anthropic"):
        api_mode = "anthropic_messages"
        print("[loop] Forcing api_mode=anthropic_messages for MiniMax")

    agent = AIAgent(
        model=model,
        provider=provider,
        base_url=base_url,
        api_mode=api_mode,
        enabled_toolsets=toolsets,
        ephemeral_system_prompt=system_prompt,
        platform="cli",
        quiet_mode=True,
        skip_context_files=True,
        skip_memory=False,
        reasoning_config={"enabled": False},
        max_iterations=80,
    )

    global current_agent
    current_agent = agent

    global next_turn_time

    conversation_history = []
    turn_count = 0
    _cancel_wired = False

    start_ws_listener()
    start_countdown(interval)
    start_quest_engine()
    start_daemon_guardian()

    try:
        while True:
            turn_count += 1
            print(f"[loop] Turn {turn_count}", flush=True)

            # Wire cancel event into tools (Hermes loads modules lazily; retry until found)
            if not _cancel_wired:
                if _wire_tool_cancel_event(cancel_event):
                    _cancel_wired = True

            with countdown_lock:
                next_turn_time = time.time() + interval

            triggered = chat_event.wait(timeout=interval)
            chat_event.clear()

            msgs = []
            if triggered:
                with message_lock:
                    msgs = list(pending_messages)
                    pending_messages.clear()
                if msgs:
                    senders = ", ".join({m.get("from", "Player") for m in msgs})
                    print(f"[loop] Chat trigger from {senders}", flush=True)
                    with countdown_lock:
                        next_turn_time = None

            is_chat_triggered = bool(msgs)

            # Standby mode: skip autonomous turns, but still respond to chat
            if _is_standby() and not is_chat_triggered:
                print("[loop] Standby mode — skipping autonomous turn", flush=True)
                send_heartbeat(next_turn_in=interval, turn_in_progress=False)
                continue

            plan = fetch_plan()
            plan_context = format_plan(plan)

            if msgs:
                chat_lines = "\n".join([
                    f"- {m.get('from', 'Player')}: {m.get('message', '')}"
                    for m in msgs
                ])
                prompt = (
                    f"New chat messages — respond immediately:\n{chat_lines}\n\n"
                    f"If this is a new task or request from the player, handle it right away. "
                    f"Remember: if the player gives you a NEW task that replaces your current work, "
                    f"FIRST call mc_plan(action='clear_goal') to wipe the old plan, "
                    f"THEN create a new plan with mc_plan(action='set_goal', ...)."
                )
            elif turn_count == 1:
                prompt = initial_prompt
            else:
                prompt = (
                    "Continue your current activity. Check your status, surroundings, "
                    "and any pending commands. Act as your character would."
                )

            if plan_context:
                prompt = f"{plan_context}\n\n{prompt}"

            turn_log = {
                "turn": turn_count,
                "time": int(time.time() * 1000),
                "prompt": prompt,
                "response": "",
                "tool_calls": [],
                "error": None,
            }

            agent._interrupt_requested = False
            cancel_event.clear()
            turn_in_progress.set()
            send_heartbeat(next_turn_in=None, turn_in_progress=True)
            try:
                result = agent.run_conversation(
                    user_message=prompt,
                    conversation_history=conversation_history,
                )

                conversation_history = result.get("messages", [])
                conversation_history = _safe_trim_history(conversation_history, max_msgs=20)

                response = result.get("final_response", "")
                turn_log["response"] = response

                is_budget_error = (
                    "maximum iterations" in (response or "")
                    or "couldn't summarize" in (response or "")
                    or "tool_call_id" in (response or "")
                )

                mc_chat_used = False
                for msg in conversation_history:
                    if msg.get("role") == "assistant" and msg.get("tool_calls"):
                        for tc in msg["tool_calls"]:
                            name = tc.get("function", {}).get("name", "")
                            turn_log["tool_calls"].append({
                                "name": name,
                                "args": tc.get("function", {}).get("arguments", ""),
                            })
                            if name == "mc_chat":
                                mc_chat_used = True

                if is_budget_error:
                    print("[loop] Budget exhausted — tools executed but summary failed. Will retry next turn.", flush=True)
                    conversation_history = []
                elif response and (is_chat_triggered or os.getenv("MC_ALWAYS_CHAT", "").lower() in ("1", "true", "yes")):
                    # If the agent used mc_chat this turn, it already spoke — don't duplicate.
                    # Otherwise, the final_response IS the chat output.
                    chat_msg = response.strip()
                    if (
                        chat_msg
                        and not chat_msg.startswith("Operation interrupted")
                        and not mc_chat_used
                    ):
                        _post_chat(chat_msg)

                if response and not is_budget_error:
                    print(f"[loop] Response: {response[:200]}", flush=True)

            except Exception as e:
                turn_log["error"] = str(e)
                print(f"[loop] Error during turn: {e}", flush=True)
            finally:
                turn_in_progress.clear()
                send_heartbeat(next_turn_in=None, turn_in_progress=False)

            log_agent_turn(turn_log)

    except KeyboardInterrupt:
        print("[loop] Interrupted. Exiting.")


def main():
    parser = argparse.ArgumentParser(description="Hermes-native persistent agent loop")
    parser.add_argument("--profile", required=True, help="Hermes profile name")
    parser.add_argument("--prompt", default="Begin.", help="Initial prompt")
    parser.add_argument("--interval", type=int, default=30, help="Seconds between idle turns")
    args = parser.parse_args()

    run_agent_loop(args.profile, args.prompt, args.interval)


if __name__ == "__main__":
    main()
