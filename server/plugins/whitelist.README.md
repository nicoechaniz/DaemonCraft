# Whitelist seeding (DC-131)

`ENFORCE_WHITELIST=true` (set in `docker-compose.yml`) means every connection
needs an explicit entry in `server/data/whitelist.json`. That file is
gitignored (it contains live UUID ↔ username mappings), so a fresh clone or
a fresh `docker compose up` boots with an **empty** whitelist — and nobody
can connect.

## ⚠️ Pre-merge checklist for the maintainer

If you currently have human players connected (e.g. `Siqui`,
`NicoElViejoGamer`, your own admin account, any Bedrock players via Geyser),
**add them to the whitelist before the next server restart that picks up
this change**. Otherwise they'll be locked out and see "You are not
whitelisted on this server!" on next reconnect.

```bash
# For each currently-known player:
docker exec -u 1000 daemoncraft-minecraft mc-send-to-console "whitelist add <username>"

# Verify:
docker exec -u 1000 daemoncraft-minecraft mc-send-to-console "whitelist list"
```

The bot accounts (`Pamplinas`, `Hermes-Clio`) get added via the same command;
they were pre-seeded on the dev box during DC-131 work.

## Bedrock / Geyser players

Bedrock usernames carry a `.` prefix when bridged through Geyser
(e.g. `.iNicoElViejoGamer`). If you whitelist by Java username only, the
Bedrock connection still fails. Either:

- Whitelist with the prefixed name explicitly, or
- Install Floodgate (currently NOT installed; tracked as DC-131 open
  question — would let Bedrock players auto-resolve to a stable UUID).

## Seed file

`whitelist.example.json` is a stub showing the format the server expects.
Real entries land in `server/data/whitelist.json` (gitignored). The server
auto-fetches the canonical Mojang UUID for online accounts; for offline-mode
servers like ours, the UUID is generated deterministically from the username
(`OfflinePlayer:<name>`).

## Removing a player

See `docs/privacy.md` — the full parent-deletion runbook (whitelist remove,
CoreProtect rollback, LuckPerms clear, usercache cleanup) lives there.
