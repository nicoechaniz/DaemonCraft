#!/bin/bash
# watch-stream.sh — observe the live bot context stream
# Usage: ./watch-stream.sh [interval]

INTERVAL=${1:-5}
STREAM=~/.hermes/sessions/daemoncraft-stream.json

watch -n "$INTERVAL" "cat $STREAM 2>/dev/null | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
    b = d.get(\"bot\", {})
    print(f\"Tick {d.get(\"tick\",\"?\")}  Health {b.get(\"health\",\"?\")}/{b.get(\"max_health\",\"?\")}  Food {b.get(\"food\",\"?\")}\")
    print(f\"Pos {b.get(\"position\",\"?\")}  Holding {b.get(\"holding\",{}).get(\"name\",\"empty\")}\")
    act = d.get(\"last_action\")
    if act: print(f\"Last action: {act.get(\"action\",\"?\")} ({act.get(\"status\",\"?\")})\")
    chat = d.get(\"last_chat\", [])
    if chat:
        for c in chat[-3:]:
            print(f\"  [{c.get(\"from\",\"?\")}]: {c.get(\"message\",\"?\")} ({c.get(\"ago\",\"?\")})\")
    errs = d.get(\"errors\", [])
    if errs: print(f\"Errors: {len(errs)}\")
    ev = d.get(\"events_consumed\", 0)
    if ev: print(f\"Events consumed: {ev}\")
except: print(\"Stream not available yet...\")
'"
