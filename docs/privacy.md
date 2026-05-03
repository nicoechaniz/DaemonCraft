# Privacy & Data Handling — DaemonCraft

Light-touch policy for the DaemonCraft server. The audience is small and
includes minors, so we keep the data footprint narrow and the deletion path
short. Companion to `plans/DC-131.md`.

---

## What we log

| Source | What | Where | Retention |
|---|---|---|---|
| Minecraft server | All player chat, joins, leaves, world edits | `server/data/logs/<date>.log.gz` (rotated daily by Purpur) | 30 days |
| CoreProtect | Block place/break, container interactions, command use | `server/data/plugins/CoreProtect/database.db` | 30 days (`co purge t:30d`) |
| Backups | World snapshots (which include chat/log fragments) | `${BACKUP_DEST}` (see `.env`) | 30 days (`PRUNE_BACKUPS_DAYS`) |
| Agent traces | Each AI agent turn (prompt → response → tool calls) | `~/.hermes/profiles/<cast>/sessions/*.json` | Manual purge — no automatic rotation yet |
| Bot Mind dashboard | In-memory ring buffer of last 50 agent turns | RAM only; cleared on bot restart | Until restart |

Player UUIDs and usernames are stored in `server/data/usercache.json` and
`server/data/whitelist.json`. UUIDs are stable; usernames may change.

## What we do NOT log

- Voice / audio. TTS output is generated, played, and the temp file deleted.
- IP addresses beyond the server's own log line at connect time (Purpur default
  log format includes IP — we don't separately persist or aggregate it).
- Anything outside Minecraft (no profiling, no telemetry to third parties).

## Identity & access

- `ONLINE_MODE: false` — the server does not authenticate against Mojang.
- `ENFORCE_WHITELIST: true` — connection requires an explicit whitelist entry.
- LuckPerms gates commands by group (`default` / `pamplina-team` / `op`).
- Anyone with `op` can read all logs and run any command. Keep that group small.

## Parent / data-subject deletion request

To remove a player's data:

```
# Remove from whitelist (prevents reconnection)
docker exec -u 1000 daemoncraft-minecraft mc-send-to-console "whitelist remove <name>"

# Roll back their builds (optional — also removes evidence of incidents)
docker exec -u 1000 daemoncraft-minecraft mc-send-to-console "co rollback u:<name> t:30d"

# Drop their LuckPerms record
docker exec -u 1000 daemoncraft-minecraft mc-send-to-console "lp user <name> clear"

# Drop their entry from usercache and playerdata
# (next restart picks this up; do this after the player is offline)
jq 'map(select(.name != "<name>"))' server/data/usercache.json > /tmp/uc.json && mv /tmp/uc.json server/data/usercache.json
rm server/data/world/playerdata/<uuid>.dat 2>/dev/null
```

For a complete wipe, also remove the player's chat lines from rotated log
files (`server/data/logs/*.log.gz`) — `zgrep -v "<name>"` then re-gzip.

## Incident review

If something needs to be reviewed (griefing, inappropriate chat):

1. Chat: `zgrep "<name>" server/data/logs/*.log.gz | head`
2. Block actions: `co lookup u:<name> t:7d`
3. Agent context (if an agent was involved): inspect the relevant session JSON
   under `~/.hermes/profiles/<cast>/sessions/`.

## Changes to this policy

This file is the source of truth. If retention or scope changes, update here
first, then notify all `op` group members. Material changes (new categories,
shorter retention, third-party export) require admin sign-off.
