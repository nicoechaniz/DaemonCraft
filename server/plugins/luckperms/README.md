# LuckPerms group definitions

`groups.json` is the authoritative group config exported from the live server via `lp export`.

## Groups

| Group | Inherits | Purpose |
|---|---|---|
| `default` | — | All players; basic chat commands only |
| `pamplina-team` | `default` | Narrative operator scope (mirrors `mc_command` capability) |
| `op` | `pamplina-team` | Full server ops; human admin only |

## Applying to a fresh server

```bash
# 1. Copy groups.json into the LuckPerms plugin data dir
cp server/plugins/luckperms/groups.json \
   server/data/plugins/LuckPerms/groups-import.json
# 2. Import via rcon
docker exec daemoncraft-minecraft rcon-cli "lp import groups-import.json"
```

## Adding a new player to a group

```bash
docker exec daemoncraft-minecraft rcon-cli "lp user <username> parent add pamplina-team"
```

## Updating group definitions

Make changes in-game or via rcon, then re-export. Use a fresh export name
each time — `lp export groups.json` is a no-op if a file with that name
already exists in the plugin data dir (LuckPerms quietly refuses to
overwrite). Pick a unique name, decode, overwrite the tracked file, then
delete the export.

```bash
EXPORT_NAME="lp-export-$(date +%s)"
docker exec -u 1000 daemoncraft-minecraft mc-send-to-console "lp export $EXPORT_NAME"
sleep 2  # let the export thread finish
docker exec daemoncraft-minecraft sh -c "gunzip -c /data/plugins/LuckPerms/${EXPORT_NAME}.json.gz" \
  > server/plugins/luckperms/groups.json
docker exec daemoncraft-minecraft rm /data/plugins/LuckPerms/${EXPORT_NAME}.json.gz
git diff server/plugins/luckperms/groups.json   # verify before commit
```
