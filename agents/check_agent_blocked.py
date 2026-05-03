#!/usr/bin/env python3
"""Check if the Minecraft agent is blocked in a tool loop.

Reads the last N lines of the agent log and determines if the agent
is stuck calling failing tools repeatedly (blocked) or making progress (working).

NOTE: We do NOT block on repetitive successful calls (e.g. 20+ mc_build
placing blocks) because that is legitimate construction. Only repeated
failures indicate a real block.

Exit codes:
    0 = working or inconclusive
    1 = blocked (repetitive failing tool calls detected)
"""

import sys
from pathlib import Path

LOG_FILE = Path.home() / ".local/share/daemoncraft/siqui/logs/Siqui_agent.log"
MAX_LINES = 80
ERROR_THRESHOLD = 7


def main() -> int:
    if not LOG_FILE.exists():
        return 0

    try:
        lines = LOG_FILE.read_text().strip().splitlines()
    except Exception:
        return 0

    recent = lines[-MAX_LINES:] if len(lines) > MAX_LINES else lines

    tool_calls = []
    for line in recent:
        if "⚡" not in line:
            continue
        parts = line.split("⚡", 1)[1].strip().split()
        if not parts:
            continue
        name = parts[0]
        has_error = "[error]" in line
        tool_calls.append((name, has_error))

    if len(tool_calls) < ERROR_THRESHOLD:
        return 0

    # 1) Same tool failing repeatedly
    last_batch = tool_calls[-ERROR_THRESHOLD:]
    first_name = last_batch[0][0]
    if all(name == first_name and err for name, err in last_batch):
        print(f"[check] Agent blocked: {ERROR_THRESHOLD}x '{first_name}' errors", file=sys.stderr)
        return 1

    # 2) Any tools failing repeatedly
    if all(err for _, err in last_batch):
        print(f"[check] Agent blocked: {ERROR_THRESHOLD}x consecutive errors", file=sys.stderr)
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
