#!/usr/bin/env bash
# One-shot installer for the ChatFilter ES wordlist (DC-131).
#
# Run this after `docker compose up -d minecraft` on a fresh deploy. It
# detects whether the ES entries are already merged into wordFilters.yml,
# appends them if not, and restarts minecraft so ChatFilter rebuilds its
# filter set (chatfilter reload doesn't pick up new wordFilters.yml entries
# — see server/plugins/chatfilter/README.md "Gotcha").
#
# Idempotent: re-running on an already-installed server is a no-op.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE="$REPO_ROOT/server/plugins/chatfilter/wordFilters-es.yml"
SENTINEL="DC-131"   # AddedBy field in wordFilters-es.yml uniquely identifies our entries

[[ -f "$SOURCE" ]] || { echo "Missing $SOURCE"; exit 1; }

# Wait for the container to be up and ChatFilter to have generated its config
until docker exec daemoncraft-minecraft test -f /data/plugins/ChatFilter/wordFilters.yml 2>/dev/null; do
  echo "Waiting for ChatFilter to generate wordFilters.yml..."
  sleep 5
done

# Check if our entries are already there
if docker exec daemoncraft-minecraft grep -q "AddedBy: $SENTINEL" /data/plugins/ChatFilter/wordFilters.yml 2>/dev/null; then
  echo "ChatFilter ES entries already installed (AddedBy: $SENTINEL present). Nothing to do."
  exit 0
fi

echo "Appending ES wordlist to /data/plugins/ChatFilter/wordFilters.yml..."
docker cp "$SOURCE" daemoncraft-minecraft:/data/plugins/ChatFilter/wordFilters-es.yml.staging

docker exec -u 1000 daemoncraft-minecraft python3 -c "
src = open('/data/plugins/ChatFilter/wordFilters-es.yml.staging').read()
body = src.split('ChatFilter:\n', 1)[1]   # strip leading header — live file already has one
with open('/data/plugins/ChatFilter/wordFilters.yml', 'a') as f:
    f.write('\n' + body)
"
docker exec -u 1000 daemoncraft-minecraft rm /data/plugins/ChatFilter/wordFilters-es.yml.staging

echo "Restarting minecraft so ChatFilter rebuilds its filter set..."
( cd "$REPO_ROOT" && docker compose restart minecraft )

echo "Done. Verify with:"
echo "  docker logs daemoncraft-minecraft 2>&1 | grep 'Enabled word filters'"
echo "  (filter count should bump above the default 55)"
