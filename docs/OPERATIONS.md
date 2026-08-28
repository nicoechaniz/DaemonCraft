# DaemonCraft — Operations

Last updated: 2026-05-10

## Service Lifecycle

### Start everything

```bash
systemctl --user start daemoncraft.service          # Minecraft server
systemctl --user start daemoncraft-cast.service      # Bots + agent loops
systemctl --user start embodied-service.service      # Gemma-Andy bridge
```

Gateways are started automatically by `daemoncraft-cast.service`.

### Stop everything

```bash
systemctl --user stop hermes-gateway@steve.service hermes-gateway@gandy.service
systemctl --user stop daemoncraft-cast.service
systemctl --user stop embodied-service.service
# daemoncraft.service (Minecraft) usually stays running
```

### Restart with code changes (template update)

```bash
cd ~/Projects/DaemonCraft
PYTHONPATH=~/Projects/DaemonCraft:$PYTHONPATH python3 agents/daemoncraft.py update companion
```

This wipes and regenerates workspaces from templates, restores `plan.json`, and restarts everything.

### Health checks

```bash
# Bots
curl -s http://localhost:3001/health   # Steve
curl -s http://localhost:3002/health   # gAndy

# Embodied service
curl -s http://localhost:7790/health

# Gateways
systemctl --user is-active hermes-gateway@steve.service hermes-gateway@gandy.service
```

### Dashboards

| Bot | URL |
|---|---|
| Steve | http://localhost:3001/dashboard |
| gAndy | http://localhost:3002/dashboard |

## Troubleshooting

### Gateway fails to start: "Failed to load environment files"

**Cause:** `.env` symlink broken or missing.
**Fix:** Verify `~/agents/<name>/.env` → `hermes-home/.env` exists and is valid.

### Gateway fails: "Connection error" on MiniMax

**Cause:** `MINIMAX_API_KEY` missing from agent `.env`.
**Fix:** Never create `.env` manually. Use `daemoncraft.py update` which inherits keys from global `.env`.

### Gateway fails: WebSocket connection error

**Cause:** Bot not ready when gateway started, or agent_loop already occupying WS.
**Fix:** Cast starts bots first, then gateways. If out of order: restart cast.

### Bot stuck, not responding to chat

**Cause:** Gateway may be blocked on a long LLM call, or user unauthorized.
**Fix:** Check gateway log: `journalctl --user -u hermes-gateway@steve.service --since "1 min ago"`
Common: `Unauthorized user` → add `GATEWAY_ALLOW_ALL_USERS=true` to `.env`.

### Plan & Goals panel empty

**Cause:** No `workspace/plan.json` exists. LLM hasn't created a plan yet.
**Expected:** Empty when no active task. Not an error.

### "Interrumpiendo" messages even with steer

**Cause:** `@name!` (exclamation) forces interrupt by design.
**Expected behavior:** `@name` = steer, `@name!` = interrupt.

## Log Locations

| Component | Command |
|---|---|
| Cast (bots + agents) | `journalctl --user -u daemoncraft-cast.service -f` |
| Steve gateway | `journalctl --user -u hermes-gateway@steve.service -f` |
| gAndy gateway | `journalctl --user -u hermes-gateway@gandy.service -f` |
| Embodied service | `journalctl --user -u embodied-service -f` |
| Steve agent log | `~/agents/steve/hermes-home/logs/agent.log` |
| gAndy agent log | `~/agents/gandy/hermes-home/logs/agent.log` |

## Skin Management

SkinsRestorer is installed on the Minecraft server. Use RCON:

```python
# Via Python RCON (localhost:25575; password comes from root .env)
# Command: skin set <player> <minecraft_username>
# Example: skin set gAndy Gandhi_TG
```

## Known Stability Issues

- **WebSocket conflict:** agent_loop.py and gateway both try to connect to bot's WS. agent_loop wins; gateway retries until bot accepts second connection. Can cause brief startup warnings.
- **Pathfinding:** Bots can get stuck on terrain. `goto_near` with `range:2` reports success even when stuck 1 block away. Recovery loop exists but position verification could be stronger.
- **MiniMax occasional failures:** Connection errors happen ~2% of calls, auto-retry handles them.
