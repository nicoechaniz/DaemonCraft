#!/usr/bin/env python3
"""
Smoke tests for DaemonCraft bot server (server.js).

Tests all major GET endpoints and the new admin endpoints.
Run from saicam1:
    python3 /home/siqui/DaemonCraft/agents/bot/smoke_test.py
Or from any host:
    python3 smoke_test.py --base-url http://10.130.40.202:3002
"""

import argparse
import json
import sys
import urllib.request
import urllib.error
from typing import Any

DEFAULT_BASE = "http://localhost:3002"
PASS = "\033[32m✓\033[0m"
FAIL = "\033[31m✗\033[0m"
WARN = "\033[33m⚠\033[0m"

failures = 0


def get(path: str, base: str = DEFAULT_BASE) -> tuple[int, Any]:
    url = base.rstrip("/") + path
    try:
        with urllib.request.urlopen(url, timeout=5) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, {}
    except Exception as e:
        return 0, {"_error": str(e)}


def post(path: str, body: dict = None, base: str = DEFAULT_BASE) -> tuple[int, Any]:
    url = base.rstrip("/") + path
    data = json.dumps(body or {}).encode()
    req = urllib.request.Request(url, data=data,
                                  headers={"Content-Type": "application/json"},
                                  method="POST")
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read())
        except Exception:
            return e.code, {}
    except Exception as e:
        return 0, {"_error": str(e)}


def check(label: str, cond: bool, detail: str = ""):
    global failures
    sym = PASS if cond else FAIL
    suffix = f"  ({detail})" if detail else ""
    print(f"  {sym} {label}{suffix}")
    if not cond:
        failures += 1


def section(title: str):
    print(f"\n{title}")
    print("─" * (len(title) + 2))


def main(base: str):
    print(f"DaemonCraft smoke tests — {base}\n")

    # ── GET endpoints ──────────────────────────────────────────────
    section("GET /health  (connectivity baseline)")
    code, body = get("/health", base)
    check("HTTP 200", code == 200, f"got {code}")
    check("ok: true", body.get("ok") is True)
    check("username present", bool(body.get("username")), repr(body.get("username")))

    section("GET /config  (new — returns runtime MC config)")
    code, body = get("/config", base)
    check("HTTP 200", code == 200, f"got {code}")
    check("ok: true", body.get("ok") is True)
    check("mc_host present", bool(body.get("mc_host")), repr(body.get("mc_host")))
    check("mc_port is int", isinstance(body.get("mc_port"), int), repr(body.get("mc_port")))
    check("username present", bool(body.get("username")))
    check("api_port is int", isinstance(body.get("api_port"), int))

    section("GET /agent/paused  (new — pause flag)")
    code, body = get("/agent/paused", base)
    check("HTTP 200", code == 200, f"got {code}")
    check("ok: true", body.get("ok") is True)
    check("paused is bool", isinstance(body.get("paused"), bool), repr(body.get("paused")))
    check("paused is false at startup", body.get("paused") is False)

    section("GET /status")
    code, body = get("/status", base)
    check("HTTP 200", code == 200, f"got {code}")
    check("ok: true", body.get("ok") is True)
    check("data object present", isinstance(body.get("data"), dict))

    section("GET /chat")
    code, body = get("/chat?count=5", base)
    check("HTTP 200", code == 200, f"got {code}")
    check("messages is list", isinstance(body.get("data", {}).get("messages"), list))

    section("GET /plan")
    code, body = get("/plan", base)
    check("HTTP 200", code == 200, f"got {code}")
    check("data object", isinstance(body.get("data"), dict))

    section("GET /actions")
    code, body = get("/actions", base)
    check("HTTP 200", code == 200, f"got {code}")
    check("ok: true", body.get("ok") is True)
    data = body.get("data")
    check("data present", data is not None, repr(type(data)))

    section("GET /agent/log  (Bot Mind panel data)")
    code, body = get("/agent/log", base)
    check("HTTP 200", code == 200, f"got {code}")
    check("ok: true", body.get("ok") is True)
    turns = body.get("data", {}).get("turns", None)
    check("turns is list", isinstance(turns, list))
    if isinstance(turns, list) and len(turns) == 0:
        print(f"  {WARN} turns is empty — expected if agent uses gateway mode (heartbeat injector)")

    section("GET /inventory")
    code, body = get("/inventory", base)
    check("HTTP 200", code == 200, f"got {code}")
    check("ok: true", body.get("ok") is True)

    section("GET /nearby")
    code, body = get("/nearby?radius=16", base)
    check("HTTP 200", code == 200, f"got {code}")
    check("ok: true", body.get("ok") is True)

    section("GET /social")
    code, body = get("/social", base)
    check("HTTP 200", code == 200, f"got {code}")

    section("GET /deaths")
    code, body = get("/deaths", base)
    check("HTTP 200", code == 200, f"got {code}")

    section("GET /task")
    code, body = get("/task", base)
    check("HTTP 200", code == 200, f"got {code}")

    section("GET /commands")
    code, body = get("/commands", base)
    check("HTTP 200", code == 200, f"got {code}")

    section("GET /dashboard  (HTML page)")
    try:
        with urllib.request.urlopen(base.rstrip("/") + "/dashboard", timeout=5) as _r:
            _dash_code = _r.status
    except Exception as _e:
        _dash_code = 0
    check("HTTP 200", _dash_code == 200, f"got {_dash_code}")

    # ── Dashboard HTML structure ───────────────────────────────────
    section("Dashboard HTML — panel structure")
    try:
        with urllib.request.urlopen(base.rstrip("/") + "/dashboard", timeout=5) as r:
            html = r.read().decode("utf-8")
        expected_panels = ["status", "plan", "chat", "actions", "inventory",
                           "task", "agent", "admin"]
        for panel in expected_panels:
            check(f'data-panel="{panel}"', f'data-panel="{panel}"' in html)
        check("Admin Controls label", "Admin Controls" in html)
        check("adm-host input", 'id="adm-host"' in html)
        check("adm-port input", 'id="adm-port"' in html)
        check("adminRestart function", "adminRestart" in html)
        check("adminSwitchServer function", "adminSwitchServer" in html)
        check("adminPause function", "adminPause" in html)
        check("adminResume function", "adminResume" in html)
        check("adminLoadConfig on DOMContentLoaded", "adminLoadConfig" in html)
    except Exception as e:
        check("HTML fetch", False, str(e))

    # ── Admin endpoints: pause/resume (reversible) ─────────────────
    section("POST /admin/pause + /admin/resume  (reversible round-trip)")
    code, body = post("/admin/pause", base=base)
    check("pause HTTP 200", code == 200, f"got {code}")
    check("pause ok:true", body.get("ok") is True)
    check("pause paused:true", body.get("paused") is True)

    _, state = get("/agent/paused", base)
    check("GET /agent/paused reflects pause", state.get("paused") is True)

    code, body = post("/admin/resume", base=base)
    check("resume HTTP 200", code == 200, f"got {code}")
    check("resume ok:true", body.get("ok") is True)
    check("resume paused:false", body.get("paused") is False)

    _, state = get("/agent/paused", base)
    check("GET /agent/paused reflects resume", state.get("paused") is False)

    # POST /admin/restart is intentionally NOT tested (would restart the service)

    # ── Unknown routes return 404 ──────────────────────────────────
    section("404 for unknown routes")
    code, _ = get("/no-such-endpoint-xyz", base)
    check("GET unknown → 404", code == 404, f"got {code}")

    # ── Summary ───────────────────────────────────────────────────
    total = 0
    # Count all check() calls
    print(f"\n{'─'*40}")
    if failures == 0:
        print(f"\033[32mAll checks passed\033[0m")
    else:
        print(f"\033[31m{failures} check(s) failed\033[0m")
    return failures


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default=DEFAULT_BASE,
                        help=f"Bot API base URL (default: {DEFAULT_BASE})")
    args = parser.parse_args()
    sys.exit(main(args.base_url))
