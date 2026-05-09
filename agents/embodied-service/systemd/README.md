# systemd unit for embodied-service

User-mode systemd unit for the embodied service. Designed to run as the
user account that owns the daemoncraft clone (no root required for the
common dev layout).

## Install (user-mode)

```bash
mkdir -p ~/.config/systemd/user
cp embodied-service.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable embodied-service.service
systemctl --user start embodied-service.service
```

Verify:

```bash
systemctl --user status embodied-service
journalctl --user -u embodied-service -f         # tail logs
curl -s http://localhost:7790/health
```

## Install (system-wide)

If you prefer a system unit (so it survives user logout):

```bash
sudo cp embodied-service.service /etc/systemd/system/
sudo sed -i 's|%h/REPOS|/opt|; s|^# .*per host.*||' /etc/systemd/system/embodied-service.service
# edit /etc/systemd/system/embodied-service.service:
#   - replace WorkingDirectory with your absolute path
#   - add a User=<service-user> line under [Service]
sudo systemctl daemon-reload
sudo systemctl enable --now embodied-service.service
```

## Tunables

Edit the `Environment=` lines in the unit (or use a drop-in at
`~/.config/systemd/user/embodied-service.service.d/override.conf`):

| Var | Meaning |
|---|---|
| `EMBODIED_SERVICE_PORT` | Port to bind. Default 7790. |
| `BOT_API_URL` | Where bot/server.js answers. Per-bot, change for AlterCraft vs DaemonCraft. |
| `OLLAMA_URL` | Where Gemma-Andy is served. Default `http://10.10.20.1:11434`. |
| `GEMMA_ANDY_MODEL` | Model tag. Default `gemma-andy:e4b-v2-2-3-q8_0`. |
| `SCHEMA_PATH` | Override to load a different schema for testing. |

## Logs

Every line is already JSON (from `logEvent()`). For the field-test
review workflow:

```bash
# Last 24h of intent activity
journalctl --user -u embodied-service --since "24 hours ago" \
  | grep -E '"event":"(intent_received|intent_done|mitigation_applied)"'

# Surface mitigation rates (recovery_naive_retry / empty_tool_calls)
journalctl --user -u embodied-service --since "7 days ago" -o cat \
  | jq -c 'select(.event=="mitigation_applied") | {regression, context_id}'
```

## Stop / restart

```bash
systemctl --user stop embodied-service
systemctl --user restart embodied-service          # picks up code or schema changes
```

After a `git pull` that touches `lib/tool_schema_v2.json` or
`lib/dispatcher.js`, restart the service. No retraining of the model
required.
