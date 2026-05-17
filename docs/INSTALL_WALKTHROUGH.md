# DaemonCraft canonical install — full walkthrough

End-to-end install of the **DaemonCraft + Hermes + Gemma-Andy + hermes-memory-kit + Minecraft server** stack on a single Linux host. Tested on Ubuntu 24.04 with Python 3.11.

This is the same stack covered piece-by-piece across `docs/ARCHITECTURE.md`, `agents/embodied-service/profile-templates/README.md`, etc. — collected here in install order with copy-pasteable commands.

> **Time budget**: ~45–60 min total. Most of it is downloads (Docker image ~500 MB, npm deps, pip deps including `sentence-transformers` ~500 MB).

---

## 0. Topology

```
┌───────────────────────────────────────────────────────────────────────┐
│                          MINECRAFT SERVER                              │
│  daemoncraft-minecraft (Docker, Purpur 1.21.11, :25565)               │
└──────────────────────────────────────────────────────────────────────┘
                              ▲
                              │  TCP / WS
                              ▼
┌──────────────────────────────────────────────────────────────────────┐
│                BOT — Mineflayer Node process (:3001)                  │
│  agents/bot/server.js — HTTP API + WebSocket + mBit perception        │
└──────────────────────────────────────────────────────────────────────┘
                              ▲
                              │  HTTP POST /intent + /chat/send
                              ▼
┌──────────────────────────────────────────────────────────────────────┐
│   EMBODIED SERVICE (:7790) — Node process                             │
│   agents/embodied-service — Gemma-Andy bridge via Ollama              │
└──────────────────────────────────────────────────────────────────────┘
                              ▲
                              │  POST /intent (Hermes invokes embodied_plan)
                              ▼
┌──────────────────────────────────────────────────────────────────────┐
│   HERMES GATEWAY (Kimi-K2.6 OAuth)                                    │
│   ~/repos/Gemma/hermes-agent — Python venv, daemoncraft platform      │
│   ~/.hermes/profiles/daemoncraft-base/ — profile + config + memory   │
└──────────────────────────────────────────────────────────────────────┘
                              ▲
                              │  read/write
                              ▼
┌──────────────────────────────────────────────────────────────────────┐
│   HERMES MEMORY KIT — vector + continuity layer                       │
│   ~/agents/<name>/agent-memory/library.db (SQLite + embeddings)       │
│   plugins: hmk-memory (prefetch) + dialogue-handoff (continuity)      │
└──────────────────────────────────────────────────────────────────────┘
                              ▲
                              │  Ollama API
                              ▼
┌──────────────────────────────────────────────────────────────────────┐
│   OLLAMA (remote or local) — gemma-andy:e4b-v2-2-3-q8_0               │
│   default: http://10.10.20.1:11434                                    │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 1. Prerequisites

```bash
# System packages
sudo apt update && sudo apt install -y \
  git docker.io docker-compose-v2 \
  python3.11 python3.11-venv python3-pip \
  nodejs npm \
  build-essential pkg-config \
  sqlite3 \
  curl jq

# Add yourself to docker group (logout/login required)
sudo usermod -aG docker $USER
```

Verify:
- `python3.11 --version` → 3.11+
- `node --version` → ≥20 for embodied-service, ≥18 for bot
- `docker --version` → 24+
- `docker compose version` → v2+

### Credentials you'll need

- **Kimi OAuth token** for `kimi-k2.6` (via Kimi CLI login). File: `~/.kimi/credentials/kimi-code.json` (auto-created by `kimi auth`).
- **Reachable Ollama** with the `gemma-andy:e4b-v2-2-3-q8_0` model. Default endpoint `http://10.10.20.1:11434`. For fully local: install Ollama and pull the model (Modelfile in `Mar-IA-no/deamoncraft-gemma4-andy`).

---

## 2. Clone DaemonCraft

```bash
mkdir -p ~/repos/Gemma && cd ~/repos/Gemma
git clone -b feat/canonical-loop https://github.com/nicoechaniz/DaemonCraft.git
cd DaemonCraft
cp .env.example .env  # optional: edit BACKUP_DEST, CF_API_KEY
```

---

## 3. Start the Minecraft server

```bash
cd ~/repos/Gemma/DaemonCraft
docker compose up -d minecraft

# Wait for healthcheck (~2 min on first run, pulls ~500 MB image)
until docker inspect daemoncraft-minecraft --format '{{.State.Health.Status}}' | grep -q healthy; do sleep 5; done
echo "MC ready"
```

Server listens:
- Java Edition: `localhost:25565`
- Bedrock Edition: `localhost:19132` (via Geyser plugin)
- RCON: `localhost:25575` (password `daemoncraft-rcon`)

---

## 4. Install + start the bot

```bash
cd ~/repos/Gemma/DaemonCraft/agents/bot
npm install   # ~2 min, 326 packages

# Start bot (foreground for first run, then convert to systemd later)
MC_HOST=localhost \
MC_PORT=25565 \
MC_USERNAME=AsciiProbe \
MC_AUTH=offline \
API_PORT=3001 \
node server.js
```

In another terminal:

```bash
# Op the bot so it can teleport / give itself starter items
docker exec daemoncraft-minecraft rcon-cli "op AsciiProbe"

# Verify
curl -s http://localhost:3001/health
# → {"ok":true,"connected":true,"username":"AsciiProbe",...}
```

> **Optional starter pack** (skip cold-start of mining cycle):
> ```bash
> for cmd in "give AsciiProbe iron_pickaxe 1" "give AsciiProbe iron_axe 1" \
>            "give AsciiProbe crafting_table 4" "give AsciiProbe furnace 2" \
>            "give AsciiProbe torch 32" "give AsciiProbe bread 16" \
>            "give AsciiProbe coal 16"; do
>   docker exec daemoncraft-minecraft rcon-cli "$cmd"
> done
> ```

---

## 5. Install the embodied service

```bash
cd ~/repos/Gemma/DaemonCraft/agents/embodied-service
npm install

# Verification log directory — embodied service writes a JSONL of every
# intent result here for offline analysis.  If missing, every intent_done
# logs a benign but noisy "verification_log_failed: ENOENT" warning.
mkdir -p ~/.local/share/daemoncraft/lab/logs

node index.js &  # foreground for now; systemd later

# Verify
curl -s http://localhost:7790/health
# → {"ok":true,"port":7790,"ollama_url":"http://10.10.20.1:11434","model":"gemma-andy:e4b-v2-2-3-q8_0",...}

# Verify Ollama has the model
curl -s http://10.10.20.1:11434/api/tags | jq '.models[].name'
# → "gemma-andy:e4b-v2-2-3-q8_0"
```

---

## 6. Install Hermes (canonical with 3 patches)

`nicoechaniz/hermes-agent` `origin/main` is current canonical. Three companion entries are missing from the toolset resolver chain (PR pending — see <https://github.com/nicoechaniz/hermes-agent/pull/7>). Until merged, apply locally:

```bash
mkdir -p ~/repos/Gemma && cd ~/repos/Gemma
git clone https://github.com/nicoechaniz/hermes-agent.git
cd hermes-agent

# venv + install (~5 min for deps)
python3.11 -m venv venv
. venv/bin/activate
pip install --upgrade pip setuptools wheel
pip install -e .
pip install aiohttp  # not in pyproject.toml but daemoncraft platform needs it

# Apply the 3 patches (or merge fork/main if PR #7 still open):
git remote add fork https://github.com/Pablomonte/hermes-agent.git
git fetch fork
git checkout fork/fix/daemoncraft-toolset-wiring -- \
    hermes_cli/platforms.py \
    hermes_cli/tools_config.py \
    toolsets.py

# Verify
python -c "
from tools.embodied_plan_tool import EMBODIED_PLAN_SCHEMA
from tools.gemma_policy import GemmaPolicy
from hermes_cli.auth import resolve_kimi_coding_runtime_credentials
from gateway.platforms.daemoncraft import DaemonCraftAdapter
from hermes_cli.platforms import PLATFORMS
from tools.registry import registry
print('✓ embodied_plan tool:', EMBODIED_PLAN_SCHEMA['function']['name'])
print('✓ daemoncraft in PLATFORMS:', 'daemoncraft' in PLATFORMS)
print('✓ embodiment toolset:', registry.get_tool_names_for_toolset('embodiment'))
"
# Should print all three ticks.
```

---

## 7. Bootstrap the Hermes profile

```bash
mkdir -p ~/.hermes/profiles/daemoncraft-base

# Mirror the canonical profile from the DaemonCraft repo
cp ~/repos/Gemma/DaemonCraft/agents/embodied-service/profile-templates/daemoncraft-base.config.yaml \
   ~/.hermes/profiles/daemoncraft-base/config.yaml
cp ~/repos/Gemma/DaemonCraft/agents/embodied-service/profile-templates/daemoncraft-base.SOUL.md \
   ~/.hermes/profiles/daemoncraft-base/SOUL.md

# Required dirs
mkdir -p ~/.hermes/profiles/daemoncraft-base/{sessions,memories,checkpoints,logs}
```

Edit `~/.hermes/profiles/daemoncraft-base/config.yaml` and append (the canonical mirror lacks platform wiring):

```yaml
platform_toolsets:
  cli:
  - embodiment
  - clarify
  - messaging
  daemoncraft:
  - embodiment
  - clarify
  - messaging

platforms:
  daemoncraft:
    enabled: true
    extra:
      bot_api_url: http://localhost:3001
      bot_username: AsciiProbe
      embodied_service_url: http://localhost:7790
```

Create `~/.hermes/profiles/daemoncraft-base/.env`:

```bash
cat > ~/.hermes/profiles/daemoncraft-base/.env <<'EOF'
GATEWAY_ALLOW_ALL_USERS=true
EMBODIED_SERVICE_URL=http://localhost:7790
BOT_API_URL=http://localhost:3001
MC_KNOWN_BOTS=AsciiProbe
OLLAMA_URL=http://10.10.20.1:11434
EOF
```

Set the sticky profile:

```bash
cd ~/repos/Gemma/hermes-agent && . venv/bin/activate
hermes profile use daemoncraft-base
```

---

## 8. Install hermes-memory-kit

```bash
cd ~/repos
git clone https://github.com/Mar-IA-no/hermes-memory-kit.git
cd hermes-memory-kit

# Install kit deps into the Hermes venv
. ~/repos/Gemma/hermes-agent/venv/bin/activate
pip install -r requirements.txt                       # zero third-party for core
pip install -r requirements-local-embeddings.txt      # sentence-transformers, ~500MB

# Bootstrap the agent workspace
python3 scripts/bootstrap_agent.py ~/agents/asciiprobe --name asciiprobe
```

The bootstrap creates `~/agents/asciiprobe/` with:
- `agent-memory/` — durable memory state (DB, handoff files, ALWAYS-CONTEXT)
- `hermes-home/` — agent-specific Hermes profile (config.yaml, SOUL.md, plugins)
- `.env` → symlink to `hermes-home/.env`
- `wiki/` — Obsidian projection (read-only canonical)
- `scripts/hmk` — wrapper that loads `.env` and dispatches `memoryctl.py` / `continuityctl.py`

### Wire memory kit into the daemoncraft-base profile

The kit's bootstrap creates a per-agent profile under `~/agents/asciiprobe/hermes-home/` — but we want it in `~/.hermes/profiles/daemoncraft-base/`. Two options:

**Option A (simpler)** — use the kit's standalone workspace:

```bash
# Switch active profile to the kit-managed one
hermes profile use asciiprobe   # if visible after bootstrap
# or set HERMES_HOME=~/agents/asciiprobe/hermes-home directly
```

**Option B (canonical for daemoncraft)** — graft the kit plugins onto the daemoncraft-base profile:

```bash
# Copy plugins
cp -r ~/agents/asciiprobe/hermes-home/plugins/dialogue-handoff \
      ~/.hermes/profiles/daemoncraft-base/plugins/
cp -r ~/agents/asciiprobe/hermes-home/plugins/hmk-memory \
      ~/.hermes/profiles/daemoncraft-base/plugins/

# Append memory + plugin config to ~/.hermes/profiles/daemoncraft-base/config.yaml
cat >> ~/.hermes/profiles/daemoncraft-base/config.yaml <<'EOF'

memory:
  provider: hmk-memory

plugins:
  enabled:
    - dialogue-handoff
EOF

# Append env vars to .env (point at the kit's data dir)
cat >> ~/.hermes/profiles/daemoncraft-base/.env <<'EOF'
HMK_AGENT_NAME=asciiprobe
HMK_WORKSPACE_ROOT=/home/pablo/agents/asciiprobe
HMK_AGENT_MEMORY_BASE=/home/pablo/agents/asciiprobe/agent-memory
HMK_DB_PATH=/home/pablo/agents/asciiprobe/agent-memory/library.db
HMK_HERMES_HOME=/home/pablo/.hermes/profiles/daemoncraft-base
HMK_MEMORYCTL_PATH=/home/pablo/agents/asciiprobe/scripts/memoryctl.py
HMK_SESSIONS_DIR=/home/pablo/.hermes/profiles/daemoncraft-base/sessions
HMK_DIALOGUE_HANDOFF_PATH=/home/pablo/agents/asciiprobe/agent-memory/state/DIALOGUE-HANDOFF.md
HERMES_HANDOFF_PATH=/home/pablo/agents/asciiprobe/agent-memory/state/DIALOGUE-HANDOFF.md
HERMES_ALWAYS_CONTEXT_PATH=/home/pablo/agents/asciiprobe/agent-memory/state/ALWAYS-CONTEXT.md
EOF

# Initialize the memory DB
cd ~/agents/asciiprobe && ./scripts/hmk memoryctl.py init
```

> **Why option B**: keeps the DaemonCraft profile as the single integration surface, so `systemctl start daemoncraft-hermes-gateway` pulls in the kit too. Option A is fine for single-agent labs but doesn't compose with the DaemonCraft cast launcher pattern.

> **Why `HMK_MEMORYCTL_PATH`**: the `hmk-memory` plugin imports `memoryctl.py` dynamically. Its lookup order is `$HMK_MEMORYCTL_PATH` → `<hermes_home>/../scripts/memoryctl.py` → `<hermes_home>/scripts/memoryctl.py` → `import memoryctl` (PYTHONPATH). Because we set `HMK_HERMES_HOME` to the gateway profile (which has no sibling `scripts/`), the `$HMK_MEMORYCTL_PATH` override is REQUIRED — without it you get `WARNING hmk-memory: prefetch failed: No module named 'memoryctl'` on every wake-up and vector recall is silently dead.

Verify memory provider is active:

```bash
HERMES_HOME=~/.hermes/profiles/daemoncraft-base hermes hmk-memory status
```

(That subcommand only appears when the provider is active.)

---

## 9. Systemd units (optional but recommended)

```bash
cat > ~/.config/systemd/user/daemoncraft-embodied-service.service <<'EOF'
[Unit]
Description=DaemonCraft Embodied Service (Path B canonical bridge to Gemma-Andy)
After=network-online.target
Wants=network-online.target
PartOf=daemoncraft-hermes-gateway.service
StartLimitIntervalSec=120
StartLimitBurst=10

[Service]
Type=simple
WorkingDirectory=%h/repos/Gemma/DaemonCraft/agents/embodied-service
ExecStart=/usr/bin/env node index.js
Environment=EMBODIED_SERVICE_PORT=7790
Environment=BOT_API_URL=http://localhost:3001
Environment=OLLAMA_URL=http://10.10.20.1:11434
Environment=GEMMA_ANDY_MODEL=gemma-andy:e4b-v2-2-3-q8_0
Environment=NODE_ENV=production
Restart=on-failure
RestartSec=5s
StandardOutput=journal
StandardError=journal
SyslogIdentifier=daemoncraft-embodied
EOF

cat > ~/.config/systemd/user/daemoncraft-hermes-gateway.service <<'EOF'
[Unit]
Description=Hermes Gateway for DaemonCraft (Kimi-K2.6 → embodied_plan → Gemma-Andy)
After=network-online.target daemoncraft-embodied-service.service
Wants=network-online.target
Requires=daemoncraft-embodied-service.service

[Service]
Type=simple
WorkingDirectory=%h/repos/Gemma/hermes-agent
ExecStart=%h/repos/Gemma/hermes-agent/venv/bin/hermes gateway run -v
Environment=HERMES_HOME=%h/.hermes/profiles/daemoncraft-base
Environment=PYTHONUNBUFFERED=1
Environment=GATEWAY_ALLOW_ALL_USERS=true
Restart=on-failure
RestartSec=5s
TimeoutStartSec=60
StandardOutput=journal
StandardError=journal
SyslogIdentifier=daemoncraft-hermes
EOF

systemctl --user daemon-reload
```

Notes:
- Both units are `static` — **no auto-start at boot** (no `[Install]` block).
- `Requires=` + `PartOf=` makes starting/stopping the gateway carry the embodied service with it.
- Bot (`agents/bot/server.js`) and MC server (docker) stay independent — start them first.

---

## 10. Verify end-to-end

```bash
# Manual order:
docker compose -f ~/repos/Gemma/DaemonCraft/docker-compose.yml up -d minecraft

# Start bot (in its own terminal or convert to systemd unit too):
cd ~/repos/Gemma/DaemonCraft/agents/bot
MC_USERNAME=AsciiProbe API_PORT=3001 node server.js &

# Start the gateway (brings up embodied service with it):
systemctl --user start daemoncraft-hermes-gateway.service

# Tail logs
journalctl --user -u 'daemoncraft-*' -f
```

In another terminal, send a chat from inside Minecraft (or via RCON):

```
@AsciiProbe contame qué ves alrededor
```

Expected gateway log:
```
gateway.run: inbound message: platform=daemoncraft user=Pa8lo msg='@AsciiProbe ...'
run_agent: tool embodied_plan completed (8.4s, 1885 chars)
run_agent: Turn ended: tool_turns=1 ... response_len=80+
gateway.platforms.base: [Daemoncraft] Sending response (~80 chars)
```

Expected bot response in MC chat: a natural Spanish/English sentence reporting what `scan_nearby` returned — **not** raw JSON like `embodied_plan:1 {"intent":"..."}`.

Memory verification (after a few turns):

```bash
cd ~/agents/asciiprobe
./scripts/hmk memoryctl.py search --query "carbón"
./scripts/hmk continuityctl.py rehydrate --dry-run
ls -la agent-memory/state/   # DIALOGUE-HANDOFF.md, NOW.md update across turns
sqlite3 agent-memory/library.db ".tables"
```

---

## 11. Daily operation

| Want | Command |
|---|---|
| Start everything | `systemctl --user start daemoncraft-hermes-gateway` (bot + MC must be up first) |
| Stop everything | `systemctl --user stop daemoncraft-hermes-gateway` |
| Restart (cycle both) | `systemctl --user restart daemoncraft-hermes-gateway` |
| Logs (live) | `journalctl --user -u 'daemoncraft-*' -f` |
| Memory search | `cd ~/agents/asciiprobe && ./scripts/hmk memoryctl.py search --query "..."` |
| Add a fact manually | `./scripts/hmk memoryctl.py add-text --shelf mc-episodic --title "..." --raw "..." --tags player,quest` |
| Rehydrate after restart | `./scripts/hmk continuityctl.py rehydrate` |
| Token / cache status | `hermes status` |
| Refresh Kimi OAuth | The gateway does it auto-on-401; manual: `kimi login` (Kimi CLI) |

---

## 12. Common pitfalls

1. **Bot WS port conflict**: only one process can connect to `ws://localhost:3001/ws`. Killing `daemoncraft-local-agent.service` (if it exists from an older install) is required before running the canonical gateway.
2. **`HERMES_HOME` fallback**: if Hermes warns "HERMES_HOME is unset…falling back to ~/.hermes", you forgot to set `HERMES_HOME` in the systemd unit or the shell. Profile dir = `~/.hermes/profiles/<name>/`, not `~/.hermes/`.
3. **`tool_turns=0` + JSON in chat**: the 3 patches from PR #7 aren't applied. The model emits the tool invocation as text because `tools=[]` reaches the API.
4. **Embodied service "ConnectError"**: usually the service crashed (Ollama unreachable, port collision). Check `journalctl --user -u daemoncraft-embodied-service -n 50`.
5. **Memory plugin not picked up**: re-check `plugins.enabled` list in `config.yaml` and that `plugins/dialogue-handoff/__init__.py` contains the string `register` (Hermes scans by string match, not import).
6. **Session contamination after a failed turn**: the model's history can contain stale tool-text leaks. `mv ~/.hermes/profiles/daemoncraft-base/sessions ~/.hermes/.../sessions.archived_$(date +%s)` to force a fresh start.

---

## 13. What lives where

| Path | Purpose | Edit? |
|---|---|---|
| `~/repos/Gemma/DaemonCraft/` | DaemonCraft canonical repo (`feat/canonical-loop`) | yes (PRs upstream) |
| `~/repos/Gemma/hermes-agent/` | Hermes canonical clone + 3 local patches | local only until PR #7 merges |
| `~/repos/hermes-memory-kit/` | Memory kit | yes (PRs to Mar-IA-no) |
| `~/.hermes/profiles/daemoncraft-base/` | Active Hermes profile | yes (config.yaml + .env) |
| `~/.hermes/profiles/daemoncraft-base/sessions/` | Per-turn JSONL conversation history | system-managed, OK to archive |
| `~/agents/asciiprobe/` | hermes-memory-kit workspace per bot | yes (DB updates via scripts/hmk) |
| `~/agents/asciiprobe/agent-memory/library.db` | SQLite + FTS5 + embeddings | system-managed; backup periodically |
| `~/.kimi/credentials/kimi-code.json` | Kimi OAuth tokens | system-managed (refreshed automatically) |
| `~/.config/systemd/user/daemoncraft-*.service` | Unit files | yes |

---

## 14. Where to go next

- **PRs upstream**: track [hermes-agent#7](https://github.com/nicoechaniz/hermes-agent/pull/7) (toolset wiring), [DaemonCraft#14](https://github.com/nicoechaniz/DaemonCraft/pull/14) (mbit-viz fixes), [DaemonCraft#15](https://github.com/nicoechaniz/DaemonCraft/pull/15) (mine_blocks botPos).
- **Multi-agent**: bootstrap a second workspace (`~/agents/gandy`), copy a templated unit file `daemoncraft-hermes-gateway@gandy.service`, and run both gateways in parallel against different bot ports.
- **Move Ollama local**: if your `10.10.20.1` is the deployed box and you want everything on one laptop, install Ollama locally, `ollama create gemma-andy -f Modelfile` (Modelfile from `Mar-IA-no/deamoncraft-gemma4-andy`), and change `OLLAMA_URL=http://localhost:11434` in both `.env` files.
- **Rolemaster cast**: `Pamplinas` needs raw `/command` slash-command access; the `embodiment` toolset alone isn't enough. See `agents/SOUL-rolemaster.md`.
