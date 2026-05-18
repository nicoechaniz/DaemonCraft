#!/usr/bin/env bash
# DaemonCraft bot restart — kills old, starts via canonical launcher
set -euo pipefail
cd ~/Projects/DaemonCraft

echo "=== Killing old bot ==="
pkill -9 -f "server.js.*config-compaii" 2>/dev/null || true
sleep 2
pgrep -f "server.js.*config-compaii" | xargs -r kill -9 2>/dev/null || true
sleep 1
while fuser 3003/tcp 2>/dev/null; do fuser -k 3003/tcp 2>/dev/null; sleep 1; done
echo "Port free"

echo "=== Starting bot via daemoncraft launcher ==="
python3 -c "
from agents.daemoncraft import start_bot
pid = start_bot('lab', 'CompAII', 3003)
print(f'PID={pid}')
"
echo "Done. Watch: ./scripts/watch-all.sh"
