# Server Overhaul — Operator Runbook

Operational reference for the DaemonCraft server overhaul (epic DC-124). Companion to `plans/DC-124.md` and the verbatim plan in `~/REPOS/vault/projects/DaemonCraft/overhaul-plan.md`.

This file is updated as each phase lands. Treat it as the single source of truth for "what versions are pinned, how do I upgrade them, how do I restore from backup".

---

## Pinned versions

### Server image (DC-125)

```
itzg/minecraft-server@sha256:629762aaf864e109a35e00b11d701cfc6b2bddca4331944aefde0a352ebb9fd4
```

Captured 2026-05-03 from `docker image inspect itzg/minecraft-server:latest --format '{{index .RepoDigests 0}}'` on a known-good running container.

**Upgrade procedure:**

1. On a scratch host (or laptop), pull the new tag and start a clean container with the same env. Smoke test: server boots healthy, Geyser loads, agent bot connects.
2. Capture the new digest: `docker image inspect itzg/minecraft-server:latest --format '{{index .RepoDigests 0}}'`
3. Open a PR that updates only the digest line in `docker-compose.yml`. PR description: what version changed, what was smoke-tested.
4. After merge, `docker compose pull && docker compose up -d` on production. Watch logs for 5 min.
5. **Never switch back to `:latest`** — that defeats the pin and makes incidents un-bisectable.

### Plugins (auto-installed via itzg)

| Plugin | Source | Version pin | Owner ticket |
|---|---|---|---|
| Geyser-Spigot | Modrinth `geyser` | `2.9.5-b1130` (`R7DKgZlt`) — pin once `feat/bedrock-geyser-support` merges upstream | DC-125 follow-up |

The Geyser pin lands as a follow-up because the `MODRINTH_PROJECTS: "geyser"` line is on the `feat/bedrock-geyser-support` branch (PR #2 to nicoechaniz). Once that merges, a small follow-up PR replaces `"geyser"` with `"geyser:R7DKgZlt"`.

### Plugins (manually installed)

Currently in `server/data/plugins/` (not auto-installed; survive the gitignored `server/data/` boundary because the plugin jars and configs are managed manually):

| Plugin | Loaded version | Source |
|---|---|---|
| Denizen | _capture from running server, see below_ | manual |
| spark | _capture from running server, see below_ | manual |

To capture loaded versions:
```
docker exec daemoncraft-minecraft mc-send-to-console "version Denizen"
docker exec daemoncraft-minecraft mc-send-to-console "version spark"
```

(These versions land in this table as part of DC-126 when LuckPerms / CoreProtect / SkinsRestorer / DecentHolograms / TAB are added — they all get one inventory pass.)

---

## Cast model configuration (DC-125)

All casts use **MiniMax-M2.7** via `provider: minimax` and `base_url: https://api.minimax.io/anthropic`. The `agents/casts/rolemaster.yaml` file was previously misconfigured with `kimi-k2.6` / `kimi-coding`; corrected in DC-125 to match the runtime.

If you add a new cast, copy the model/provider/base_url block from `companion.yaml` as the canonical reference.

---

## Difficulty (DC-125)

Server-wide default: **easy**. Permits hostile mob spawns (needed for rolemaster narrative tension) while keeping kid-friendly damage scaling.

Pamplinas (rolemaster cast) can issue `/difficulty peaceful` for specific scenes via `mc_command`; the server-wide default reverts on next restart.

**Gotcha**: existing worlds store difficulty in `level.dat` (NBT) which overrides `server.properties`. Changing the env var alone does nothing for an already-generated world. Apply once via console:
```
docker exec daemoncraft-minecraft rcon-cli difficulty easy
```
This persists into `level.dat`. New worlds pick up the env value at generation.

---

## Backup + restore (DC-126)

### Sidecar: `itzg/mc-backup`

Pinned digest: `itzg/mc-backup@sha256:7ffba80d2c6752df8d1669451de928f9e7b2d94866cd84951af6e7bc5bed1496`

Schedule: daily (`BACKUP_INTERVAL=24h`, 5-minute initial delay).
Destination: `${BACKUP_DEST}` from `.env` (default: `./server/backups/` local placeholder).

**Open item — final destination**: move `BACKUP_DEST` to Hetzner Storage Box or Backblaze B2 once the project decides; only the volume mapping in `.env` and `docker-compose.yml` changes, sidecar logic stays.

**How it works**: on each scheduled run, mc-backup connects via RCON (`RCON_PASSWORD` from `.env`) and issues `save-off → save-all flush → snapshot → save-on`. The snapshot is a `.tar.gz` of `/data/`.

**Test a restore**:
```bash
mkdir /tmp/restore-test
cd /tmp/restore-test
tar -xzf ~/REPOS/daemoncraft/server/backups/daemoncraft-YYYYMMDD-HHMMSS.tar.gz
# Mount into a scratch itzg container and verify world loads
docker run --rm -v /tmp/restore-test:/data \
  -e EULA=true -e TYPE=PURPUR -e VERSION=1.21.11 \
  itzg/minecraft-server@sha256:629762...
```

**Retention**: 30 days (controlled by `PRUNE_BACKUPS_DAYS=30`).

---

## CoreProtect (DC-126)

Installed: v23.1 (Modrinth `HD2IvrxS`). Note: 1.21.11 is not yet listed in Modrinth's game-version metadata but 23.1 loads and enables cleanly on Purpur 1.21.11 (verified 2026-05-03). Backend: SQLite.

**Test rollback**:
```bash
# In-game, deliberately place/break a test block as a non-admin user
docker exec daemoncraft-minecraft rcon-cli "co rollback u:<username> t:1h r:10"
```

**Alert on bulk griefing**: CoreProtect logs everything; for active monitoring wire a log watcher to `server/data/plugins/CoreProtect/` (future DC-132 scope).

---

## LuckPerms group definitions (DC-126)

Installed: v5.5.17-bukkit (Modrinth `OrIs0S6b`). Storage: H2.

Group hierarchy and `groups.json` import procedure: see `server/plugins/luckperms/README.md`.

| Group | Scope |
|---|---|
| `default` | All players — `/help`, `/msg`, `/me`, `/reply` |
| `pamplina-team` | Narrative operator — time, weather, gamemode, tp, give, effect, difficulty, say, title, summon, kill |
| `op` | Full wildcard (`*`) — human admin only |

**Emptying `op.json`**: once LuckPerms is the authority, `op.json` should be empty or contain only the admin UUID. Run:
```bash
docker exec daemoncraft-minecraft rcon-cli "deop <any-legacy-op-username>"
```
then add them to the `op` group:
```bash
docker exec daemoncraft-minecraft rcon-cli "lp user <username> parent add op"
```

---

## Whitelist / invite-code procedure (DC-131 — pending)

Onboarding runbook lands here.

---

## Daily metrics report (DC-132 — pending)

Aggregation script and read-the-output guide land here.
