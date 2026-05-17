#!/bin/bash
# send-event.sh — write an intervention to the inner CompAII via event queue
# Usage:
#   ./send-event.sh message "We fixed the creative mode bug."
#   ./send-event.sh tool mc_command "/tp CompAII 500 120 -320"
#   ./send-event.sh code 8f0f650 "TP safety fix deployed"
#   ./send-event.sh world "setblock at (544,145,-386) replaced beacon"
#   ./send-event.sh chat NicoElViejoGamer "hola CompAII"
#   BOT=<name> ./send-event.sh message "hello"  # target specific bot

BOT="${BOT:-${MC_USERNAME:-CompAII}}"
BOT=$(echo "$BOT" | tr '[:upper:]' '[:lower:]')
EVENTS_FILE=~/.hermes/sessions/"${BOT}-events.jsonl"

if [ $# -lt 2 ]; then
  echo "Usage: $0 <type> [args...]"
  echo "Types: message <text> | tool <name> <cmd> | code <hash> <note> | world <note> | chat <player> <text>"
  echo "Set BOT=name to target a different bot."
  exit 1
fi

TYPE="$1"
TS=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
shift

case "$TYPE" in
  message|tool|code|world|chat)
    python3 -c "
import json, sys
ts = '$TS'
typ = '$TYPE'
args = sys.argv[1:]
if args and args[0] == '--':
    args = args[1:]
if typ == 'message':
    d = {'ts': ts, 'src': 'cli', 'event': 'message', 'text': ' '.join(args)}
elif typ == 'tool':
    d = {'ts': ts, 'src': 'cli', 'event': 'tool_called', 'tool': args[0], 'cmd': ' '.join(args[1:])}
elif typ == 'code':
    d = {'ts': ts, 'src': 'cli', 'event': 'code_changed', 'commit': args[0], 'note': ' '.join(args[1:])}
elif typ == 'world':
    d = {'ts': ts, 'src': 'cli', 'event': 'world_change', 'note': ' '.join(args)}
elif typ == 'chat':
    d = {'ts': ts, 'src': 'gateway', 'event': 'chat', 'player': args[0], 'text': ' '.join(args[1:])}
print(json.dumps(d, ensure_ascii=False))
" -- "$@"
    ;;
  *)
    echo "Unknown type: $TYPE"
    exit 1
    ;;
esac >> "$EVENTS_FILE"

echo "Event queued for bot: $BOT"
