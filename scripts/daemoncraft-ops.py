#!/usr/bin/env python3
"""
daemoncraft-ops.py — Single source of truth for operating the DaemonCraft system.

Centralizes:
  - status: services + bot position + mode + L4 session + recent activity
  - mode: switch between lab and autonomous
  - restart: consolidated restart of hermes-gateway + daemoncraft-cast
  - speak: send a chat message to the bot (one-shot)
  - log: tail recent gateway log lines
  - session: inspect the active L4 session (last messages, tool calls, turn count)
  - health: HTTP probes on bot server + gateway endpoints
  - tools: list available mc_* and mc_navigate actions

This script replaces ad-hoc systemctl + curl + grep sequences. Use it
as the primary interface for operating the system.

Usage:
  ./scripts/daemoncraft-ops.py status
  ./scripts/daemoncraft-ops.py mode lab
  ./scripts/daemoncraft-ops.py mode autonomous
  ./scripts/daemoncraft-ops.py restart [--gateway-only|--cast-only]
  ./scripts/daemoncraft-ops.py speak "hola bot"
  ./scripts/daemoncraft-ops.py log --tail 30
  ./scripts/daemoncraft-ops.py session
  ./scripts/daemoncraft-ops.py health
  ./scripts/daemoncraft-ops.py tools
  ./scripts/daemoncraft-ops.py watch [--interval 5]   # live status

Environment:
  HERMES_HOME              default ~/.hermes
  DAEMONCRAFT_HOME         default ~/Projects/DaemonCraft
  BOT_API_URL              default http://localhost:3003
  GATEWAY_URL              default not used (gateway uses WS, not HTTP)
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from typing import Any

HERMES_HOME = os.environ.get("HERMES_HOME", os.path.expanduser("~/.hermes"))
DAEMONCRAFT_HOME = os.environ.get("DAEMONCRAFT_HOME", os.path.expanduser("~/Projects/DaemonCraft"))
BOT_API_URL = os.environ.get("BOT_API_URL", "http://localhost:3003")

GATEWAY_SVC = "hermes-gateway.service"
CAST_SVC = "daemoncraft-cast.service"


# ──────────────────────────────────────────────────────────────────────
# HTTP helpers
# ──────────────────────────────────────────────────────────────────────

def http_get(url: str, timeout: float = 5.0) -> dict | None:
    """GET a URL and return parsed JSON, or None on error."""
    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp:
            return json.loads(resp.read())
    except Exception as e:
        return {"_error": str(e), "_url": url}


def http_post(url: str, payload: dict, timeout: float = 10.0) -> dict | None:
    """POST a JSON payload and return parsed JSON response."""
    try:
        data = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(url, data=data, method="POST",
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read())
    except Exception as e:
        return {"_error": str(e), "_url": url}


def systemctl(args: list[str], user: bool = True) -> tuple[int, str, str]:
    """Run systemctl --user and return (rc, stdout, stderr)."""
    cmd = ["systemctl"]
    if user:
        cmd.append("--user")
    cmd.extend(args)
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        return r.returncode, r.stdout, r.stderr
    except subprocess.TimeoutExpired:
        return 124, "", "systemctl timed out"
    except Exception as e:
        return 1, "", str(e)


def pgrep(pattern: str) -> list[str]:
    try:
        r = subprocess.run(["pgrep", "-af", pattern], capture_output=True, text=True, timeout=5)
        if r.returncode == 0:
            return [l for l in r.stdout.strip().split("\n") if l and "bash" not in l and "grep" not in l]
        return []
    except Exception:
        return []


# ──────────────────────────────────────────────────────────────────────
# Subcommands
# ──────────────────────────────────────────────────────────────────────

def cmd_status(_args):
    """Show current state of the system."""
    print("=" * 70)
    print("DaemonCraft System Status")
    print("=" * 70)
    print()

    # Services
    print("── Services ──")
    for svc in [GATEWAY_SVC, CAST_SVC]:
        rc, out, err = systemctl(["is-active", svc])
        active = "active" if rc == 0 else f"INACTIVE (rc={rc})"
        print(f"  {svc:35s} {active}")
    print()

    # Processes
    print("── Processes ──")
    for label, pattern in [
        ("Gateway (hermes-gateway)", r"hermes.*gateway.*run"),
        ("Cast (daemoncraft.py)",    r"daemoncraft\.py daemon"),
        ("Bot server (node)",        r"node server\.js"),
    ]:
        procs = pgrep(pattern)
        if procs:
            for p in procs[:2]:
                print(f"  {label}: {p[:90]}")
        else:
            print(f"  {label}: (none)")
    print()

    # Bot state
    print("── Bot state ──")
    data = http_get(f"{BOT_API_URL}/status")
    if data and data.get("ok"):
        d = data.get("data", {})
        pos = d.get("position", {})
        print(f"  position: ({pos.get('x', '?')}, {pos.get('y', '?')}, {pos.get('z', '?')})")
        print(f"  health:   {d.get('health', '?')}/20")
        print(f"  food:     {d.get('food', '?')}/20")
        held = d.get("heldItem")
        print(f"  held:     {held.get('name') if held else 'none'}")
        ents = d.get("entities", []) or []
        hostiles = [e for e in ents if e.get("kind") == "hostile"][:3]
        if hostiles:
            print(f"  hostile_nearby: {len(hostiles)}")
            for h in hostiles:
                print(f"    - {h.get('name', h.get('type', '?'))} at {h.get('position', '?')}")
    else:
        print(f"  (bot server unreachable: {data})")
    print()

    # Controller mode
    print("── Controller mode ──")
    mode_data = http_get(f"{BOT_API_URL}/controller/mode")
    if mode_data and mode_data.get("ok"):
        mode = mode_data.get("data", {}).get("mode", "?")
        if mode == "lab":
            print(f"  mode: {mode}  (no autonomous turns — bot only acts on user input)")
        else:
            print(f"  mode: {mode}  (bot runs 24/7 — may start its own turns)")
    else:
        print(f"  (mode check failed: {mode_data})")
    print()

    # L4 session
    cmd_session(_args, brief=True)


def cmd_mode(args):
    """Switch controller mode (lab | autonomous)."""
    if not args.mode:
        print("ERROR: mode required (lab|autonomous)", file=sys.stderr)
        sys.exit(1)
    if args.mode not in ("lab", "autonomous"):
        print(f"ERROR: mode must be 'lab' or 'autonomous', got '{args.mode}'", file=sys.stderr)
        sys.exit(1)

    print(f"Setting mode to '{args.mode}'...")
    r = http_post(f"{BOT_API_URL}/controller/mode", {"mode": args.mode})
    if r and r.get("ok"):
        new_mode = r.get("data", {}).get("mode", "?")
        print(f"OK. mode is now '{new_mode}'")
        if new_mode == "lab":
            print("  → bot will NOT start autonomous turns. It only acts on user input.")
            print("  → to talk to it: ./scripts/daemoncraft-ops.py speak 'your message'")
        else:
            print("  → bot runs 24/7. Heartbeats trigger agent turns autonomously.")
    else:
        print(f"ERROR: {r}", file=sys.stderr)
        sys.exit(1)


def cmd_restart(args):
    """Consolidated restart: gateway + cast (or one of them)."""
    gateway = not args.cast_only
    cast = not args.gateway_only

    if not gateway and not cast:
        print("ERROR: --gateway-only and --cast-only are mutually exclusive with full restart", file=sys.stderr)
        sys.exit(1)

    if gateway:
        print("── Restarting hermes-gateway ──")
        rc, out, err = systemctl(["restart", GATEWAY_SVC])
        if rc != 0:
            print(f"  restart returned rc={rc}, stderr={err[:200]}")
        else:
            print("  OK")
        print("  waiting 5s for service to come up...")
        time.sleep(5)
        rc, out, _ = systemctl(["is-active", GATEWAY_SVC])
        print(f"  status: {'active' if rc == 0 else f'INACTIVE (rc={rc})'}")

    if cast:
        print("\n── Restarting daemoncraft-cast ──")
        rc, out, err = systemctl(["restart", CAST_SVC])
        if rc != 0:
            print(f"  restart returned rc={rc}, stderr={err[:200]}")
        else:
            print("  OK")
        print("  waiting 4s for bot server.js to come up...")
        time.sleep(4)
        rc, out, _ = systemctl(["is-active", CAST_SVC])
        print(f"  status: {'active' if rc == 0 else f'INACTIVE (rc={rc})'}")

    print("\n── Verifying bot reachable ──")
    for i in range(5):
        d = http_get(f"{BOT_API_URL}/status")
        if d and d.get("ok"):
            pos = d.get("data", {}).get("position", {})
            print(f"  OK. bot at ({pos.get('x', '?')}, {pos.get('y', '?')}, {pos.get('z', '?')})")
            return
        time.sleep(2)
    print("  bot server not reachable after restart. Check: journalctl --user -u daemoncraft-cast")


def cmd_speak(args):
    """Send a chat message to the bot (one-shot)."""
    if not args.message:
        print("ERROR: message required", file=sys.stderr)
        sys.exit(1)
    msg = " ".join(args.message)
    print(f"Sending to bot: {msg!r}")
    r = http_post(f"{BOT_API_URL}/chat/send", {"message": msg})
    if r and r.get("ok"):
        print("OK")
    else:
        print(f"ERROR: {r}", file=sys.stderr)
        sys.exit(1)


def cmd_log(args):
    """Tail recent gateway log lines."""
    log = os.path.join(HERMES_HOME, "logs", "gateway.log")
    if not os.path.exists(log):
        print(f"Log not found: {log}", file=sys.stderr)
        sys.exit(1)
    with open(log) as f:
        lines = f.readlines()
    tail = lines[-args.tail:] if args.tail > 0 else lines
    print(f"── {log} (last {len(tail)} lines) ──")
    for line in tail:
        print(line.rstrip())


def cmd_health(_args):
    """HTTP probes on key endpoints."""
    print("── Health probes ──")
    endpoints = [
        ("bot /status",           f"{BOT_API_URL}/status"),
        ("bot /controller/mode",  f"{BOT_API_URL}/controller/mode"),
        ("bot /blocks",           f"{BOT_API_URL}/blocks?x1=16&y1=64&z1=-48&x2=18&y2=66&z2=-46&format=visual"),
        ("bot /navigate legend",  f"{BOT_API_URL}/navigate?action=visual_legend"),
    ]
    for name, url in endpoints:
        t0 = time.time()
        r = http_get(url, timeout=10.0)
        dt = (time.time() - t0) * 1000
        if r is None or "_error" in r:
            print(f"  ✗ {name:30s} {dt:6.0f}ms  {r.get('_error', '?') if r else 'timeout'}")
        else:
            print(f"  ✓ {name:30s} {dt:6.0f}ms  ok={r.get('ok')}")


def cmd_session(_args, brief: bool = False):
    """Inspect the active L4 session via session DB."""
    db = os.path.join(HERMES_HOME, "agent-memory", "sessions.db")
    if not os.path.exists(db):
        print("  (no sessions.db)")
        return
    try:
        import sqlite3
        conn = sqlite3.connect(db)
        conn.row_factory = sqlite3.Row
        # Look for sessions table; if not present, skip
        try:
            cur = conn.execute("SELECT name FROM sqlite_master WHERE type='table' LIMIT 20")
            tables = [r["name"] for r in cur.fetchall()]
        except Exception:
            tables = []
        if not tables:
            print("  (sessions.db is empty or schema not found)")
            conn.close()
            return
        # Find the most likely sessions table
        for table in tables:
            if "session" in table.lower():
                sessions_table = table
                break
        else:
            sessions_table = tables[0]
        cur = conn.execute(f"SELECT * FROM {sessions_table} ORDER BY started_at DESC LIMIT 3")
        print(f"── L4 sessions (from {sessions_table}) ──")
        for r in cur.fetchall():
            d = dict(r)
            for k in list(d.keys()):
                if isinstance(d[k], str) and len(d[k]) > 60:
                    d[k] = d[k][:60] + "..."
            print(f"  {d}")
        conn.close()
    except Exception as e:
        print(f"  (session inspect failed: {e})")
    if brief:
        return
    # If not brief, also tail recent L4 turns
    print()
    print("── Recent L4 turns (last 10 from gateway log) ──")
    log = os.path.join(HERMES_HOME, "logs", "gateway.log")
    if os.path.exists(log):
        with open(log) as f:
            lines = f.readlines()
        turns = [l for l in lines if "Heartbeat classified" in l or "tool_call" in l.lower() or "inbound message" in l.lower()]
        for line in turns[-10:]:
            print("  " + line.rstrip())


def cmd_tools(_args):
    """List available mc_* and mc_navigate actions by querying the bot server."""
    print("── mc_* tools (from bot server config) ──")
    # We don't have a direct endpoint that lists all tools, so show the
    # help from the canonical action names known to the system.
    tools = [
        # Movement
        ("mc_move",       "movement (goto, goto_near, follow, stop, deathpoint)"),
        # Perception
        ("mc_perceive",   "status, nearby, scene, health, interoception, stats"),
        ("mc_bit",        "3D visual grid (format=visual, type-based CJK)"),
        ("mc_navigate",   "11 perception actions (see below)"),
        ("mc_screenshot", "PNG screenshot from bot's POV"),
        # Building
        ("mc_build",      "place, fill, interact (close doors, etc.)"),
        # Mining
        ("mc_mine",       "dig, collect"),
        # Combat
        ("mc_combat",     "attack, fight, flee, eat, equip, etc."),
        # Inventory
        ("mc_craft",      "craft, smelt"),
        # Communication
        ("mc_chat",       "chat, whisper, chat_to, team_chat"),
        # Waypoints
        ("mc_manage",     "chest, deposit, withdraw, mark, marks, go_mark, cancel"),
        # Macros
        ("mc_macro",      "tunnel, spiral, staircase (escape only)"),
        # Plans
        ("mc_plan",       "set_goal, get_plan, update_task"),
        # Registry
        ("mc_registry",   "blocks, entities, biomes, items, effects"),
        # No-op
        ("mc_no_op",      "break the rhythm (debug only)"),
    ]
    for name, desc in tools:
        print(f"  {name:18s} {desc}")
    print()
    print("── mc_navigate actions (11 total) ──")
    nav_actions = [
        ("identify_cave",      "am I in a cave? escape route + tools"),
        ("identify_interior",  "am I inside a structure? enriched fields (access_points, missing_blocks, furni, hostile_presence, is_safe, safety_issues, volume_blocks)"),
        ("find_doors",         "list all doors in radius with is_open state"),
        ("verify_door",        "check a specific door's state + hinge_side + has_door_top"),
        ("scan_structure",     "full structure context: interior + doors + furni + safety"),
        ("walkable",           "list of cells the bot can stand on"),
        ("path_to",            "run pathfinder, return waypoints + reachability (fail-fast)"),
        ("corners",            "4 corner cells of walkable area + bounding box"),
        ("escape_routes",      "cardinal directions with distance + blocker + best_escape"),
        ("structure_outline",  "bounding boxes of distinct structures in radius"),
        ("verify_block",       "exact block name at a position (companion to type-based CJK)"),
        ("visual_legend",      "canonical block→char mapping (single source of truth for visualizer)"),
    ]
    for name, desc in nav_actions:
        print(f"  mc_navigate(action={name!r:30s} {desc})")
    print()
    print("── Server endpoints (HTTP) ──")
    endpoints = [
        ("GET  /status",                    "bot state (position, health, food, entities)"),
        ("GET  /controller/mode",           "current mode (lab|autonomous)"),
        ("POST /controller/mode",           "switch mode"),
        ("GET  /blocks?...&format=visual",  "3D scan as text (LLM) + blocks[] (visualizer) with char field"),
        ("GET  /navigate?action=...",       "11 perception actions"),
        ("GET  /mbit",                      "2D visualizer (legacy)"),
        ("GET  /mbit3d",                    "3D visualizer (Three.js)"),
        ("GET  /chat/send",                 "send chat message"),
    ]
    for ep, desc in endpoints:
        print(f"  {ep:42s} {desc}")


def cmd_watch(args):
    """Live status, refresh every N seconds."""
    interval = args.interval if hasattr(args, "interval") else 5
    print(f"Watching every {interval}s. Ctrl+C to stop.")
    print()
    try:
        while True:
            # Clear screen (ANSI escape)
            print("\033[2J\033[H", end="")
            print(f"DaemonCraft Live Status (refresh every {interval}s)")
            print("=" * 70)
            # Just the essentials: services + bot pos + mode + last log line
            services = []
            for svc in [GATEWAY_SVC, CAST_SVC]:
                rc, _, _ = systemctl(["is-active", svc])
                services.append(f"{svc}={'OK' if rc == 0 else 'X'}")
            print("  " + " | ".join(services))
            data = http_get(f"{BOT_API_URL}/status")
            if data and data.get("ok"):
                d = data.get("data", {})
                pos = d.get("position", {})
                print(f"  bot: ({pos.get('x', '?')}, {pos.get('y', '?')}, {pos.get('z', '?')}) "
                      f"health={d.get('health', '?')} food={d.get('food', '?')}")
            mode_data = http_get(f"{BOT_API_URL}/controller/mode")
            if mode_data and mode_data.get("ok"):
                print(f"  mode: {mode_data.get('data', {}).get('mode', '?')}")
            log = os.path.join(HERMES_HOME, "logs", "gateway.log")
            if os.path.exists(log):
                with open(log) as f:
                    lines = f.readlines()
                if lines:
                    print(f"  last log: {lines[-1].rstrip()[:80]}")
            time.sleep(interval)
    except KeyboardInterrupt:
        print("\nstopped.")


# ──────────────────────────────────────────────────────────────────────
# Argument parsing
# ──────────────────────────────────────────────────────────────────────

def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="daemoncraft-ops",
        description="DaemonCraft operations CLI — single source of truth for system control",
    )
    sub = p.add_subparsers(dest="command", required=True)

    # status
    sub.add_parser("status", help="show current state of the system")

    # mode
    p_mode = sub.add_parser("mode", help="switch controller mode")
    p_mode.add_argument("mode", nargs="?", choices=["lab", "autonomous"], help="new mode")

    # restart
    p_restart = sub.add_parser("restart", help="consolidated restart (gateway + cast)")
    p_restart.add_argument("--gateway-only", action="store_true",
                          help="only restart the gateway, not the cast")
    p_restart.add_argument("--cast-only", action="store_true",
                          help="only restart the cast, not the gateway")

    # speak
    p_speak = sub.add_parser("speak", help="send a chat message to the bot")
    p_speak.add_argument("message", nargs=argparse.REMAINDER,
                         help="message text (will be sent as a chat message)")

    # log
    p_log = sub.add_parser("log", help="tail recent gateway log lines")
    p_log.add_argument("--tail", type=int, default=30, help="number of lines")

    # health
    sub.add_parser("health", help="HTTP probes on key endpoints")

    # session
    sub.add_parser("session", help="inspect the active L4 session")

    # tools
    sub.add_parser("tools", help="list available mc_* tools and mc_navigate actions")

    # watch
    p_watch = sub.add_parser("watch", help="live status, refresh every N seconds")
    p_watch.add_argument("--interval", type=int, default=5, help="refresh interval (s)")

    return p


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    handler = globals().get(f"cmd_{args.command}")
    if not handler:
        print(f"ERROR: no handler for {args.command}", file=sys.stderr)
        return 1
    try:
        handler(args)
    except KeyboardInterrupt:
        print("\ninterrupted.")
        return 130
    return 0


if __name__ == "__main__":
    sys.exit(main())
