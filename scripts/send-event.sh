#!/bin/bash
# send-event.sh — write an intervention to the inner CompAII via event queue
# Usage:
#   ./send-event.sh message "We fixed the creative mode bug. Try stone_bricks."
#   ./send-event.sh tool mc_command "/tp CompAII 500 120 -320"
#   ./send-event.sh code 8f0f650 "TP safety abort fix deployed"
#   ./send-event.sh world "setblock at (544,145,-386) replaced beacon"

EVENTS_FILE=~/.hermes/sessions/daemoncraft-events.jsonl

if [ $# -lt 2 ]; then
  echo "Usage: $0 <type> [args...]"
  echo "Types:"
  echo "  message <text>"
  echo "  tool <tool_name> <command>"
  echo "  code <commit_hash> <note>"
  echo "  world <note>"
  exit 1
fi

TYPE="$1"
TS=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
shift

case "$TYPE" in
  message)
    TEXT="$@"
    EVENT=$(python3 -c "
import json
print(json.dumps({
    'ts': '$TS',
    'src': 'cli',
    'event': 'message',
    'text': '''$TEXT'''
}))
")
    ;;
  tool)
    TOOL="$1"
    CMD="$2"
    EVENT=$(python3 -c "
import json
print(json.dumps({
    'ts': '$TS',
    'src': 'cli',
    'event': 'tool_called',
    'tool': '$TOOL',
    'cmd': '''$CMD'''
}))
")
    ;;
  code)
    COMMIT="$1"
    NOTE="$2"
    EVENT=$(python3 -c "
import json
print(json.dumps({
    'ts': '$TS',
    'src': 'cli',
    'event': 'code_changed',
    'commit': '$COMMIT',
    'note': '''$NOTE'''
}))
")
    ;;
  world)
    NOTE="$@"
    EVENT=$(python3 -c "
import json
print(json.dumps({
    'ts': '$TS',
    'src': 'cli',
    'event': 'world_change',
    'note': '''$NOTE'''
}))
")
    ;;
  *)
    echo "Unknown type: $TYPE"
    exit 1
    ;;
esac

echo "$EVENT" >> "$EVENTS_FILE"
echo "Event queued: $(echo $EVENT | python3 -c 'import sys,json; d=json.load(sys.stdin); print(f\"{d[\"event\"]}\")')"
