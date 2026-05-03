# DaemonCraft Project Memory

## CRITICAL: Systemd Service Management

This project runs as a **systemd user service** (`daemoncraft.service`).

- **DO NOT** run `docker compose up/down` manually for normal operations.
- **ALWAYS** use systemd commands:
  - Start: `systemctl --user start daemoncraft.service`
  - Restart: `systemctl --user restart daemoncraft.service`
  - Stop: `systemctl --user stop daemoncraft.service`
  - Status: `systemctl --user status daemoncraft.service`
  - Logs: `journalctl --user -u daemoncraft.service -f`

Service file location: `/home/nicolas/.config/systemd/user/daemoncraft.service`

### Agent Cast Launcher Service

There is a SECOND service (`daemoncraft-cast.service`) that manages the AI agent cast:
- Start: `systemctl --user start daemoncraft-cast.service`
- Stop: `systemctl --user stop daemoncraft-cast.service`
- Status: `systemctl --user status daemoncraft-cast.service`
- Logs: `journalctl --user -u daemoncraft-cast.service -f`

**IMPORTANT:** `daemoncraft-cast.service` and manual `python3 daemoncraft.py update <cast>` commands are MUTUALLY EXCLUSIVE. Running both at the same time creates DUPLICATE agent processes, causing:
- Conflicting bot commands
- Double chat messages
- Erratic behavior
- "Waiting for agent turns..." in dashboard

**Rule:** Before running any manual `daemoncraft.py` command, ALWAYS stop the systemd service first:
```bash
systemctl --user stop daemoncraft-cast.service
```

**To change game modes:** edit `~/.config/daemoncraft/cast.conf`, set `CAST=<name>`, then restart:
```bash
systemctl --user restart daemoncraft-cast.service
```

Available casts: `landfolk`, `civilization`, `companion`, `rolemaster`

Service file: `/home/nicolas/.config/systemd/user/daemoncraft-cast.service`

## Hermes Agent Integration — Development Workflow

When DaemonCraft features require changes to `hermes-agent` (gateway adapter, toolsets, platform config), follow this workflow to avoid breaking the running gateway or your CLI sessions.

### Three Locations of hermes-agent

| Location | Purpose | What runs from here |
|----------|---------|---------------------|
| `~/.hermes/hermes-agent` | **Active install / deploy** | `hermes-gateway.service`, `hermes update` |
| `~/Projects/hermes-agent` | **Clean rebase workspace** | Development, rebasing, PRs |
| GitHub `nicoechaniz/hermes-agent` | **Public fork** | `origin` remote — convergence point |

### The Fork (nousmain pattern)

- `nousmain` — local-only branch, clean mirror of `upstream/main`. Never pushed.
- `main` — integration branch on `origin`. Contains `upstream/main` + all our merged features. `hermes update` pulls this.
- `feat/*`, `fix/*` — feature branches rebased onto `nousmain`, merged into `main`.

See the full fork workflow in the wiki: `~/wiki/projects/hermes-agent/notes/workflow.md`

### Testing DaemonCraft Changes That Touch hermes-agent

**The deploy is a disposable sandbox.** Merge your hermes-agent feature branch directly into `~/.hermes/hermes-agent`, test end-to-end, then revert with `git reset --hard origin/main`. The workspace stays on `main` untouched.

**Pre-flight check (conflict prevention):**

Work branches are rebased onto `nousmain` (clean upstream), not onto `main` (which has our merged features). Before touching the deploy, verify that the branch merges cleanly into `main`:

```bash
cd ~/Projects/hermes-agent
git checkout main
git merge feat/<project>-<id>-description --no-edit --no-commit
# If conflicts appear, abort and fix the branch first:
git merge --abort
# If clean, abort and proceed:
git merge --abort
```

**Deploy sandbox:**

```bash
# 1. Ensure deploy is clean
cd ~/.hermes/hermes-agent
git status                    # should be clean
git log --oneline -1          # should be origin/main

# 2. Merge the branch to test (local workspace branch)
# If the branch only exists in the workspace, the remote 'local-project'
# already points to ~/Projects/hermes-agent (one-time setup)
git fetch local-project feat/<project>-<id>-description
git merge --no-edit local-project/feat/<project>-<id>-description

# 3. Restart whatever you are testing
systemctl --user restart hermes-gateway.service
# Or open a new Hermes CLI session

# 4. TEST

# 5. REVERT — deploy back to clean main
git reset --hard origin/main
systemctl --user restart hermes-gateway.service
```

**Why this works:**
- `~/.hermes/hermes-agent` is a separate git clone from the workspace.
- `git reset --hard origin/main` instantly discards the test merge — no traces left.
- The editable install loads from the deploy, so the running code changes immediately.
- Your CLI sessions (and this agent) remain safe because the workspace never leaves `main`.

**Safety rules:**
- Never push from the deploy.
- Never leave the deploy with a test merge — always revert before `hermes update`.
- If `hermes update` complains about local changes, you forgot to revert. Run `git reset --hard origin/main`.

### Hot-Fix / Debug Workflow (When Iterating from a CLI Session)

**NEVER edit files by hand in `~/.hermes/hermes-agent/` during a debug session.** Even when chasing a bug in real-time, the workspace (`~/Projects/hermes-agent/`) is the single source of truth. Hand-editing the deploy creates an unrecorded delta between repo and running code, makes revert impossible, and causes exactly the kind of confusion where the gateway runs a frankenstein of manual patches that don't match any branch.

**Correct hot-fix sequence:**

```bash
# 1. Edit in workspace ONLY
v ~/Projects/hermes-agent
# ... edit files ...

# 2. Stage + WIP commit (so the change is recorded)
git add <files>
git commit -m "WIP: debug DC-XXX <brief description>"

# 3. Copy ONLY the changed files to deploy
# (do NOT run git operations inside the deploy during hot-fix)
cp ~/Projects/hermes-agent/gateway/run.py ~/.hermes/hermes-agent/gateway/run.py
cp ~/Projects/hermes-agent/gateway/platforms/daemoncraft.py ~/.hermes/hermes-agent/gateway/platforms/daemoncraft.py
# ... etc for each changed file ...

# 4. Restart service
systemctl --user restart hermes-gateway.service

# 5. TEST

# 6. If fix works — clean up workspace commit (amend/squash later into proper commit)
#    If fix fails — revert workspace with git checkout and try again.
```

**What NOT to do:**
- `patch` / `sed` / `echo` inside `~/.hermes/hermes-agent/` directly
- Edit with vim/nano inside the deploy
- Run `git merge` inside the deploy for a hot-fix (merge is for testing complete branches, not single-file iterations)

**Exception:** Config-only changes in `~/.hermes/config.yaml` or `~/.hermes/profiles/<name>/` are safe to edit directly because they are not versioned in the hermes-agent repo.

### hermes-gateway.service — Always points to deploy

The systemd service hardcodes the deploy path:
- `WorkingDirectory=/home/nicolas/.hermes/hermes-agent`
- `PYTHONPATH=/home/nicolas/.hermes/hermes-agent`

This is the **only safe default**. The service must never point to the workspace — that path is what caused new Hermes sessions to break earlier (workspace was on a branch without `feat/kimi-oauth-clean`).

### Config Changes (platform_toolsets)

Some DaemonCraft features require adding toolsets to `platform_toolsets` in `~/.hermes/config.yaml`. This is a config change, not a code change, and is safe to do directly:

```yaml
platform_toolsets:
  daemoncraft:
  - minecraft
  - messaging
  - memory
  - vision
  - tts
```

These changes are global (affect all platforms) but are backward-compatible.

## Agent Operations & Troubleshooting

### Starting / Stopping / Updating Agents

**Preferred command for development (code changes, prompt edits):**
```bash
cd ~/Projects/DaemonCraft/agents
python3 daemoncraft.py update companion
```
This does a full hard restart: stops bot+agent, wipes profile, recreates from latest code, restores plan/locations, starts fresh.

**Before ANY manual `daemoncraft.py` command:**
```bash
systemctl --user stop daemoncraft-cast.service
```
Failure to do this = duplicate agents, conflicting commands, chat spam.

**Check for duplicate agents:**
```bash
ps aux | grep agent_loop | grep -v grep
```
There should be EXACTLY ONE process per agent. If you see duplicates, kill them all and restart:
```bash
kill -9 <pid1> <pid2>
python3 daemoncraft.py update companion
```

### What Gets Persisted Across Updates

- ✓ `workspace/plan-steve.json` — active goal and tasks (auto-saved/restored)
- ✓ `workspace/locations-steve.json` — saved locations
- ✗ `conversation_history` — cleared on every update (intentional, prevents toxic history)
- ✗ Profile config — recreated from cast YAML every update

### Chat Reaction Architecture

The agent loop is **event-driven** via WebSocket:
- Player chat → bot server receives it → broadcasts via WebSocket `type:chat`
- Agent's WebSocket listener receives it → sets `chat_event`
- Main thread wakes from `chat_event.wait(timeout=30)` → processes chat immediately

**Chat interrupt:** If a turn is already running when chat arrives, the agent sets `_interrupt_requested = True`, causing `run_conversation()` to exit early. The next turn then processes the chat message. This prevents chat from being trapped behind long mining/building sessions.

**Self-echo filter:** Steve's own chat messages are filtered out in the WebSocket listener (`from != "steve"`). Without this, Steve would trigger himself into an infinite echo loop, burning API calls to say "*waits*" every 2-3 seconds.

**Idle auto-relay:** On heartbeat turns (no player chat), Steve's internal monologue is NOT sent to Minecraft chat. Only chat-triggered turns auto-relay responses. This prevents Steve from talking to himself every 30 seconds.

### Common Failure Modes

| Symptom | Cause | Fix |
|---------|-------|-----|
| Dashboard shows "waiting for agent turns..." | Agent crashed, hanging, or duplicate agents | Check `ps aux | grep agent_loop`, kill duplicates, `update` |
| Steve chats non-stop every 30s | Idle heartbeat auto-relay was firing | Fixed — only chat-triggered turns relay now |
| Steve echoes himself infinitely | Self-messages triggered turns | Fixed — self-echo filter in WebSocket handler |
| Steve ignores my chat for minutes | Long turn (20 tool calls) blocking chat processing | Fixed — chat interrupt mechanism |
| Plan disappears after update | Profile wiped, plan not restored | Fixed — `update` now saves/restores plan-steve.json |
| Two agents running | systemd service + manual command both active | `systemctl --user stop daemoncraft-cast.service` |
| "Reached maximum iterations (20)" | Agent used all 20 tool calls in one turn | Normal for complex tasks; interrupt helps for urgent chat |

### Log Locations

- Agent log: `~/.local/share/daemoncraft/companion/logs/Steve_agent.log`
- Bot log: `~/.local/share/daemoncraft/companion/logs/Steve_bot.log`
- Dashboard: `http://localhost:3001/dashboard`

### Model / Provider

- **Model:** MiniMax-M2.7
- **Provider:** `minimax`
- **Base URL:** `https://api.minimax.io/anthropic`
- **API Key:** Passed explicitly to `AIAgent` in `agent_loop.py` via `os.environ.get("MINIMAX_API_KEY")` — Hermes' internal credential discovery fails for MiniMax when not passed explicitly.
- **Reasoning:** Disabled (`reasoning_config={"enabled": False}`)
- **Max iterations:** 80 (tool calls per turn) — increased to take advantage of MiniMax prompt caching
- **API mode:** `anthropic_messages` (forced in `agent_loop.py` when provider is `minimax` and base_url ends with `/anthropic`)

### Context Compression Disabled (Critical Fix)

**Root cause of `tool_call_id not found` errors:** Hermes' context compressor (`compression.enabled: true`) compresses old messages to save tokens. When it compresses an `assistant` message containing `tool_calls` but leaves the subsequent `tool` result messages, the `tool_call_id` references become orphaned. AIAgent's budget-exhaustion "grace call" sends these orphaned IDs to the API, which rejects them with `400 tool_call_id not found`.

**Fix:** `daemoncraft.py` now sets `config["compression"] = {"enabled": False}` when creating agent profiles. This is permanent — profiles are recreated on every `update`, so the fix lives in the profile generator.

**Date resolved:** 2026-04-26

### Files That Matter

| File | Purpose |
|------|---------|
| `agents/agent_loop.py` | WebSocket listener, turn loop, chat interrupt, auto-relay |
| `agents/daemoncraft.py` | Cast launcher, profile setup, update/start/stop/status |
| `agents/bot/server.js` | Mineflayer bot, HTTP API, WebSocket broadcast |
| `agents/casts/companion.yaml` | Cast config: model, provider, port, template |
| `agents/prompts/landfolk/steve.md` | Steve's character prompt |
| `agents/SOUL-minecraft.md` | Companion mode core rules |
| `~/.hermes/profiles/steve/config.yaml` | Runtime profile config (auto-generated) |
| `~/.hermes/profiles/steve/workspace/plan-steve.json` | Active goal + tasks (persisted) |

### Dashboard

The bot serves a live dashboard at `http://localhost:PORT/dashboard` (e.g. `http://localhost:3002/dashboard` for Pamplinas).

**Features:**
- **Collapsible panels** — click any panel header or the ▼/▶ toggle to collapse/expand
- **Collapse All / Expand All** buttons in the header
- **State persistence** — collapse state is saved to `localStorage` and restored on reload
- **Live WebSocket feed** — status, chat, actions, agent turns, background task
- **Adventures panel** — browses `agents/blueprints/*.json`, shows metadata, phases, and entities. Click an adventure to view its full blueprint.

**Endpoints:**
- `GET /blueprints` — list all blueprint files with metadata
- `GET /blueprints/:name` — retrieve a specific blueprint JSON

The active Hermes install at `~/.hermes/hermes-agent` is **NEVER** to be directly modified for feature work.

## Server Plugins Location (CRITICAL)

**The actual plugin JARs live in `server/data/plugins/`, NOT `server/plugins/`.**

- `server/plugins/` (repo root) — **Only Denizen scripts**, mounted read-only into the container via `docker-compose.yml` (`./server/plugins/denizen:/data/plugins/Denizen/scripts:ro`).
- `server/data/plugins/` — **All plugin JARs and their data**: Multiverse-Core, WorldEdit, Citizens, Denizen, Geyser, Floodgate, LibsDisguises, packetevents, spark. This directory is persisted inside the Docker volume (`./server/data:/data`).

**Common pitfall:** Running `ls server/plugins/` shows only `denizen`. The JARs are in `server/data/plugins/`.

### Plugin List (confirmed loaded)
- `multiverse-core.jar` (4.3.14) — world management
- `worldedit-bukkit-7.4.2.jar` — WorldEdit
- `citizens2.jar` + `Citizens/` — NPC framework
- `denizen.jar` + `Denizen/` — scripting
- `geyser-spigot.jar` + `Geyser-Spigot/` — Bedrock bridge
- `floodgate-spigot.jar` + `floodgate/` — auth bridge
- `LibsDisguises.jar` + `LibsDisguises/` — entity disguises
- `packetevents-spigot-2.12.1.jar` — packet API

## Cast.conf Persistence After Reboot

After a system restart, `daemoncraft-cast.service` auto-starts using whatever `CAST=` value is in `~/.config/daemoncraft/cast.conf`. **This is the only source of truth for which cast launches on boot.**

- If you want Pamplinas (rolemaster) after reboot, `cast.conf` must say `CAST=rolemaster` before the reboot.
- Current file: `~/.config/daemoncraft/cast.conf`

## Network Architecture (Host Mode)

`minecraft`, `geyser`, and `lan-broadcast` services use `network_mode: host` so LAN/VPN discovery works via UDP multicast.

- **Minecraft Java**: binds directly to host port `25565/tcp` on ALL interfaces
- **Geyser Bedrock**: binds directly to host port `19132/udp` on ALL interfaces
- **LAN Broadcast**: sends UDP multicast to `224.0.2.60:4445` every 1.5s for Java client discovery
- **Bot API** (bridge network): `http://localhost:3000` (Mineflayer HTTP API)

## VPN / LAN Reachability

Primary reachable interface: `ztuhfc4bvn` (AlterMundi VPN)
- VPN IP: `10.10.20.27/24`
- Server is accessible at `10.10.20.27:25565` (Java) and `10.10.20.27:19132` (Bedrock)
- Binding is `0.0.0.0` so it works on localhost, LAN, and VPN simultaneously.

## World Settings

- **Difficulty:** Peaceful (no hostile mobs)
- **Time:** Normal day/night cycle (`doDaylightCycle true`)
- **Game Mode:** Survival
- **Online Mode:** false (offline/cracked allowed)
- **Datapack:** `daemoncraft_vis` — coordinates HUD + colored team markers + glowing

## Lobby World (DEPRECATED — Complex Lobby Discarded)

**Status: DISCARDED.** The elaborate 6-floor Lobby Matrix with showrooms, structure catalog, mob pedestals, and item gondolas has been abandoned. It was an empty shell with no real utility and added unnecessary complexity.

**What remains:** The `lobby` flat world still exists as a simple empty space managed by Multiverse-Core. It may be used for ad-hoc creative building or testing, but it is NOT part of the adventure pipeline.

## Adventure Design in World (New Architecture)

**Principle:** Adventures are designed *in situ* inside the main `world`, not in a separate lobby. Players and Pamplinas walk the terrain together, mark locations, and build the blueprint interactively.

### Design Workflow

1. **Exploration** — Players and Pamplinas explore the `world` together. They find natural terrain features (caves, rivers, villages, ruins) that fit the story.

2. **Marking** — Players say things like *"Pamplinas, la fase 1 va acá"*. Pamplinas uses `mc_story(action="log_event", event="Phase 1 marker at X,Y,Z")` and updates the blueprint JSON with those coordinates.

3. **Blueprint Editing** — Pamplinas can load the current blueprint, edit phases, entities, and events using `mc_story` tools. The blueprint JSON lives in `agents/blueprints/<name>.json` and is shared with the dashboard.

4. **Implementation** — When the design is ready, run `python3 scripts/blueprint-engine.py init agents/blueprints/<name>.json` to execute init.commands with automatic entity tagging and block tracking. Pamplinas can also trigger this via a tool call.

5. **Reset** — To restart the adventure from scratch, run `python3 scripts/blueprint-engine.py cleanup agents/blueprints/<name>.json`. This kills all tagged entities, removes tracked blocks (setblock → air, fill → air), and cleans up sensors.

### Key Differences from Old Pipeline

| Old Pipeline (Discarded) | New In-World Design |
|---|---|
| Separate `lobby` world with Y-level showrooms | Main `world` is the canvas |
| Blueprint compiler generates datapacks + schematics | Pamplinas executes commands directly via `mc_command` |
| Per-adventure worlds via Multiverse | Single `world`, zones marked by coordinates |
| Relocatable blueprints with dynamic center | Coordinates are absolute, chosen by walking the terrain |
| Complex regeneration preserving player progress | Simple cleanup: remove tagged entities/blocks, re-run init |

### Blueprint Format (Unchanged)

Still uses the same JSON schema:
- `metadata` — title, theme, tone
- `setting` — biome, center coordinates (chosen in-world), radius
- `init` — sensor setup + initial commands
- `phases` — trigger, objectives, events (commands + chat), timeout
- `entities` — mobs/NPCs to spawn
- `objects` — items, books, signs
- `flags` — narrative state

### Files That Matter

| File | Purpose |
|------|---------|
| `agents/blueprints/*.json` | Adventure definitions |
| `agents/blueprints/el-codigo-que-suena.json` | Saira's story (reference) |
| `agents/SOUL-rolemaster.md` | Pamplinas identity + tools |
| `agents/casts/rolemaster.yaml` | Cast config (1 agent: Pamplinas) |
| `scripts/build-lobby-v4.py` | **Deprecated** — kept for reference only |
| `scripts/blueprint-engine.py` | **NEW** — Init executor + tagging + cleanup for blueprints |
| `scripts/generate-minecraft-registry.js` | Generates `minecraft-registry.json` from PrismarineJS data |

## Player Notes

- **Siqui** is a human player (IP 10.10.20.158), not a bot. Connecting via VPN.
- **NicoElViejoGamer** is a human player.

## Agent Architecture (Native Hermes Profiles)

Each agent is a **native Hermes profile** (`~/.hermes/profiles/<name>/`) with true isolation:
- `config.yaml` — model, provider, toolsets, system prompt
- `SOUL.md` — persistent identity/behavior rules
- `memories/` — MEMORY.md, USER.md
- `sessions/` — conversation history
- `logs/` — agent logs
- `workspace/` — files (locations JSON, etc.)
- `state.db` — SQLite session store
- `cron/` — scheduled jobs
- `home/` — subprocess isolation (git, ssh, etc.)

### Tools

**10 consolidated Minecraft tools** wrap the Mineflayer HTTP API:
- `mc_perceive` — status, nearby, map, look, scene, inventory, read_chat, commands, social, sounds, overhear
- `mc_navigate` — goto, follow, stop, look_at, pathfind
- `mc_build` — place, fill, interact, close
- `mc_craft` — craft, recipes, smelt
- `mc_manage` — bg_goto, bg_collect, bg_fight, task_status, cancel, mark, marks, go_mark, deposit, withdraw, chest
- `mc_chat` — chat, chat_to, whisper
- `mc_scene` — scene description, block/entity queries
- `mc_screenshot` — ray-traced world capture (CPU, optimized)
- `mc_command` — execute any Minecraft server command (requires operator privileges)
- `mc_story` — narrative state tracker: flags, objectives, phases, blueprints (Role Master mode)

**2 meta tools:**
- `clarify` — agent asks user for clarification
- `send_message` — cross-platform messaging (Telegram, Discord, etc.)

**Required for Telegram:** Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_HOME_CHANNEL` in `~/.hermes/.env`.

### Screenshots

The bot captures screenshots via **prismarine-viewer** (Three.js WebGL renderer) + **puppeteer** (headless Chrome):
- Viewer runs on `API_PORT + 1000` (e.g. 4002 for bot on 3002), first-person perspective
- Puppeteer launched with `--use-angle=swiftshader` for working WebGL in headless mode
- Lazy-init: browser and page are created on first screenshot call and reused
- Default: 1280x720, saved to `/tmp/daemoncraft-screenshots/`
- Endpoint: `GET /screenshot` or `POST /action/screenshot`
- Tool: `mc_perceive(type="screenshot")` returns path to captured image
- Tool: `mc_screenshot` for custom filename/width/height
- Agent can then use the `vision` toolset to analyze the image
- **FOV:** 120 degrees (patched via `sed` on `node_modules/prismarine-viewer/public/index.js`)
- **PNG extension:** auto-appended if missing in `file_name`

**Post-install note:** After `npm install`, re-run the FOV patch:
```bash
sed -i 's/PerspectiveCamera(75,/PerspectiveCamera(120,/g' \
  agents/bot/node_modules/prismarine-viewer/public/index.js
```

**Old system (removed):** `mine-photo` CPU ray-tracer produced corrupted output (noise/static). Fully replaced. No fallback.

### Creating an Agent Profile

```bash
cd ~/Projects/DaemonCraft
python3 -m agents.hermescraft.profile_launcher Steve --mc-username Steve
```

### Multi-Agent Launcher

```bash
# Launch any cast from a YAML config
python3 agents/daemoncraft.py start agents/casts/landfolk.yaml
python3 agents/daemoncraft.py status agents/casts/landfolk.yaml
python3 agents/daemoncraft.py stop agents/casts/landfolk.yaml
python3 agents/daemoncraft.py logs agents/casts/landfolk.yaml Steve

# Available casts:
#   agents/casts/companion.yaml      (1 agent)
#   agents/casts/civilization.yaml   (7 agents)
#   agents/casts/landfolk.yaml       (5 agents)
```

## Project Structure

```
agents/
├── bot/                    # Mineflayer HTTP API (server.js, lib/, tests/)
├── daemoncraft.py          # Cast launcher, profile setup, systemd integration
├── agent_loop.py           # Native Hermes AIAgent persistent loop
├── casts/                  # Cast configuration files
├── prompts/                # Character personality files (12+ characters)
├── skills/                 # Behavior skill files (6 skills)
├── SOUL-*.md               # Mode-specific identity and rules
└── blueprints/             # Adventure blueprint JSON files
docs/
├── design/                 # Architecture and design proposals
│   ├── daemoncraft-platform-adapter.md  # Hermes gateway adapter design (v5)
│   └── chat-output-pipeline-v1.md       # Chat pipeline design (approved, implemented)
├── CIVILIZATION_MODE.md    # Legacy mode docs (still functional)
├── COMPANION_MODE.md
├── LANDFOLK_MODE.md
└── archive/                # Outdated docs (pre-Purpur, pre-native-profiles)
    ├── server-setup.md        # Forge 1.20.1 / Phi-Craft era
    ├── cross-play-setup.md    # Geyser Standalone era
    ├── mod-integration.md     # Phi-Craft mod integration (not implemented)
    └── daemon-profile-template.md  # Old gateway-based profile creation
```

### Design Documents (`docs/design/`)

These are **canonical architecture proposals** reviewed by Claude Code and Opus. They override ad-hoc decisions and should be consulted before implementing gateway, chat pipeline, or platform adapter features:
- **`daemoncraft-platform-adapter.md`** — Hermes gateway adapter design: WebSocket inbound, HTTP outbound, TTS integration, session mapping (whisper vs broadcast), multi-agent casts, migration path (Phases 1-4).
- **`chat-output-pipeline-v1.md`** — Chat pipeline design: removed SAY: filter, unified chunking in server.js, brevity rules in SOUL-base.md. **Approved and implemented.**

## Modes

| Mode | Agents | SOUL | Status |
|------|--------|------|--------|
| Companion | 1 (Steve) | `SOUL-minecraft.md` | **Legacy / test mode** |
| Civilization | 7 (Marcus, Sarah, Jin, Dave, Lisa, Tommy, Elena) | `SOUL-civilization.md` | **Legacy / test mode** |
| Landfolk | 5 (Steve, Moss, Reed, Flint, Ember) | `SOUL-landfolk.md` | **Legacy / test mode** |
| Role Master | 1 (Pamplinas) | `SOUL-rolemaster.md` | **Active — currently deployed** |
| HoloCraft | N/A | `SOUL-holocraft.md` | **Future vision — asset generation pipeline** |

## Migration Plan

Full migration plan lives in the wiki:
`~/wiki/projects/DaemonCraft/notes/migration-plan.md`

Key phases:
1. ✓ Fix broken SOULs (Companion + Landfolk migrated, all prompts verified)
2. ✓ Create generic mode launcher (daemoncraft.py + YAML cast configs)
3. ✓ Migrate missing primitives (bin/mc, setup.sh)
4. ✓ Migrate mode documentation
5. ✓ Per-agent state migration (from shared `data/` to profile `workspace/`)
6. ✓ Automated tests (tool registration, profile creation, cast config parsing)
7. ✓ Integration test: spawn Landfolk cast
8. ✓ Deploy Landfolk mode on live server

## Completed This Session (2026-05-02)

- **DC-112 Single-LLM Architecture**: Implemented and tested. Gateway owns all cognition; agent_loop is heartbeat injector only.
- **Two-level event system**: Context-only heartbeats (silent injection) vs wake-up events (forced tool_choice=required).
- **mc_no_op tool**: Added for silent reactions when wake-up event requires tool call but no action is needed.
- **tool_choice propagation**: Fixed NameError in gateway/run.py — _run_agent now accepts tool_choice parameter.
- **DaemonCraft adapter wiring**: Restored Platform.DAEMONCRAFT in _create_adapter, auth maps, and home channel skip (was lost in rebase).
- **Sandbox testing**: Validated end-to-end — heartbeats silent, chat responses working, wake-up events triggering agent turns.
- **Branch consolidation**: DaemonCraft feat/dc-105 merged to main. Hermes-agent changes consolidated in feat/dc-112-daemoncraft-gateway rebased onto nousmain, merged to main, pushed to origin.
- **Dashboard regression identified**: DC-123 created — BOT MIND, PLAN & GOALS, BACKGROUND TASK empty after DC-112. TTS also affected.

## DaemonCraft Architectural Principles

**Gateway owns ALL cognition (DC-112):**
The Hermes gateway is the single AIAgent session for DaemonCraft. The agent_loop's sole purpose is to poll sensors every 30s and inject heartbeat context into the gateway via the bot server's WebSocket. This eliminates the dual-LLM split-brain and makes the agent truly grounded (one memory, one plan, one mind).

**Gateway owns reactive/social, agent_loop owns proactive tick:**
The Hermes gateway handles ALL reactive responsibilities (chat, TTS, event narration, plan mutations from player input). The agent_loop handles the proactive tick loop (heartbeat, sensor polling, quest trigger evaluation) that Hermes lacks natively. This is now fully implemented via DC-112.

**Provider changes require explicit user confirmation:**
NEVER change LLM provider or model configurations without explicit user confirmation. Providers are paid API services. The user explicitly pays for them and has cost, privacy, and availability preferences that the agent does not have visibility into. The agent has ZERO authority to choose, switch, or default to any provider on the user's behalf. Always ask before touching any provider setting.

- **Screenshot tool**: `mc_screenshot` with ray-traced rendering via `mine-photo`
- **SOUL-landfolk.md**: Migrated from archive with modern tool syntax
- **Skill primitives**: All 5 behavior skills updated to consolidated tools
- **Character prompts**: All 12+ prompts verified and updated
- **Bug fix**: Patched `mine-photo` `\r\n` vs `\n` bug in block loading
- **Launcher**: `daemoncraft.py` with YAML cast configs for all 3 modes
- **Setup**: `setup.sh` adapted for native profile approach
- **Docs**: Mode documentation for Companion, Civilization, Landfolk
- **State**: Per-agent workspace isolation in Hermes profiles
- **Tests**: 3 automated test suites (tools, configs, profiles)
- **Deploy**: Landfolk cast (5 agents) running on live Minecraft server
- **Lattice**: Now used via terminal CLI (skill: lattice-cli). MCP server disabled.
- **Config**: Removed mcp_servers from ~/.hermes/config.yaml
- **Daemon mode**: Implemented supervisor loop that restarts dead agents/bots (DC-13)
- **Toolset restriction**: Stripped terminal/file/web from agents to prevent rogue subprocesses
- **Systemd service**: Created `daemoncraft-cast.service` for managed cast launching
- **Telegram messaging**: Added `messaging` toolset + `HERMES_SESSION_PLATFORM=telegram` env so agents can use `send_message`
- **Persistent agent loop**: `agent_loop.py` uses Hermes `AIAgent` directly — no more subprocess spawning (DC-18)
- **Mine-photo perf**: Reduced samples 16→8, scan area 64x32x64→48x24x48, fixed undefined samples NaN bug (DC-19)
- **Civilization deploy**: 7 agents on ports 3006-3012 all healthy (DC-20)
- **Coordinates HUD**: Vanilla datapack shows live XYZ in action bar for all players
- **Player markers**: Team colors + glowing effect — see everyone through walls
- **Reconnect fix**: Eliminated bot join-leave loop race condition (DC-16)
- **Dead code removed**: Deleted `gateway_minecraft.py`, `civilization.py`, `profile_launcher.py` (DC-17)
- **Behavior skills migrated**: building, farming, navigation, survival, combat — adapted to 8-tool names, auto-installed on profile creation (DC-22)
- **Goal system**: `minecraft-goals.md` skill gives agents phase progression (Phase 1→4) and project tracking (DC-26)
- **bin/mc CLI**: Human-facing bot control CLI migrated from archive (DC-27)
- **Companion mode**: `SOUL-minecraft.md` adapted, `companion.yaml` cast config created (DC-23, DC-25)
- **All docs migrated**: CIVILIZATION_MODE.md, COMPANION_MODE.md, LAN_PLAY.md (DC-28)
- **World type fix**: Removed `LEVEL_TYPE` from docker-compose.yml to restore default normal terrain (flat vs normal world generation)
- **Auto-disguise**: Bot auto-executes `/disguise allay` on spawn
- **Pamplinas team**: Added to daemoncraft_vis datapack (light_purple team, coords HUD)
- **Hover removed**: Spring-damper hover physics removed — interfered with pathfinder/follow movement. Pamplinas now uses standard creative flight only.

## Lattice Task Status

Done: DC-1 through DC-8, DC-10 through DC-28, DC-68 through DC-76, DC-95 through DC-112, DC-118 through DC-122  
Cancelled: DC-78 (Multiverse Pipeline), DC-80 (Lobby Matrix), DC-82 (Showroom), DC-83 (Relocatable blueprints) — discarded in favor of in-world design (2026-04-28)  
Backlog: DC-77 (error frequency tracker), DC-79 (blueprint conversion), DC-81 (blueprint compiler), DC-84 (regeneration), DC-85 through DC-91 (in-world blueprint engine), DC-111 (spike: Hermes /voice mode), DC-123 (dashboard/TTS regression after DC-112), DC-124 through DC-132 (Server Setup Overhaul epic — see plans/DC-124.md)

### Epic: DC-124 — Server Setup Overhaul

**Status: in_planning (2026-05-03)** — branch `overhaul/server-setup`, 5-PR strategy.
Source: Claude Opus 4.7 architectural review, archived in vault at `projects/DaemonCraft/overhaul-plan.md`.
Blocks on: DC-123.

| Task | Phase | Notes |
|------|-------|-------|
| DC-125 | 0 — stabilize | image SHA pin, rolemaster.yaml model fix, plugin version inventory |
| DC-126 | 1a — hardening | Docker limits, mc-backup sidecar, CoreProtect, LuckPerms |
| DC-127 | 1b — server visual | SkinsRestorer + DecentHolograms + Better Leaves + Clean Glass + TAB |
| DC-128 | 1c — Java client | `daemoncraft.mrpack` (Modrinth App, shaders opt-in) |
| DC-129 | 1d — Bedrock client | `daemoncraft.mcpack` via Geyser/packs/ |
| DC-130 | 2 — docs | SOUL-rolemaster stage-tools cheatsheet |
| DC-131 | safety | whitelist + chat moderation |
| DC-132 | observability | Plan plugin + agent metrics JSONL |

Deferred per plan: multi-server mesh, Velocity proxy, Terraform, pre-built worlds.

### Epic: DC-105 — Unified Social Routing

**Status: DONE — merged to main (2026-05-02).**

| Task | Status | Notes |
|------|--------|-------|
| DC-109 | done | Phase 0 Prep: interrupt endpoint, plan epoch, BODY.md, DC_LOOP_MODE |
| DC-110 | done | BODY.md fix: removed mc_chat, terminal/file tools, "ask for goal" |
| DC-106 | done | Gateway consumes quest_event and blueprint_updated from WebSocket |
| DC-107 | done | Gateway owns all player-facing chat: bot filtering, @mention, interrupt |
| DC-108 | done | Loop Embodiment Cleanup: remove chat, fake injection |
| DC-111 | done | Gateway tool discovery: added 'minecraft' to CONFIGURABLE_TOOLSETS, fixed check_minecraft_available |
| DC-112 | done | Single-LLM architecture (gateway owns cognition, loop = heartbeat injector) |

**Merged to main (2026-05-02):** `feat/dc-105-unified-social-routing` → `main`

### Epic: DC-112 — Single-LLM Architecture

**Status: DONE — merged to main via `feat/dc-112-daemoncraft-gateway` (2026-05-02).**

| Task | Status | Notes |
|------|--------|-------|
| DC-118 | done | Define wake_up vs context event classification in heartbeat data |
| DC-119 | done | Add mc_no_op tool for silent wake-up reactions |
| DC-120 | done | Propagate tool_choice through AIAgent → transport → API |
| DC-121 | done | Implement synthetic tool call injection (assistant + tool messages) |
| DC-122 | done | End-to-end validation: heartbeats silent, chat works, wake-ups trigger turns |

**Files changed in hermes-agent:**
- `gateway/platforms/daemoncraft.py` (new — heartbeat handler, two-level event system)
- `gateway/platforms/base.py` (tool_choice field in MessageEvent)
- `gateway/run.py` (propagate tool_choice, restore DaemonCraft wiring)
- `agent/transports/chat_completions.py` (dynamic tool_choice in API payload)
- `run_agent.py` (accept and propagate tool_choice parameter)

**Branches:**
- DaemonCraft: `feat/dc-105-unified-social-routing` → `main` (merged 2026-05-02)
- hermes-agent: `feat/dc-112-daemoncraft-gateway` → `main` (merged 2026-05-02, pushed to origin)

**Deploy status (2026-05-02):**
- Workspace (`~/Projects/hermes-agent`): clean on `main`, 4 commits ahead of origin/main
- Deploy (`~/.hermes/hermes-agent`): sandbox mode ended — will update via `hermes update`
- `hermes-gateway.service` uses deploy path (correct)
- `daemoncraft-cast.service` running with DC-112 agent_loop (heartbeat injector only)

### Epic: Adventure Management Dashboard (DC-67)

**Status: COMPLETE (DC-68–DC-76), but REGRESSED by DC-112.**
Dashboard panels BOT MIND, PLAN & GOALS, BACKGROUND TASK are empty because agent_loop no longer sends turns to `/agent/log`. ACTION LOG still works (bot server). TTS relay also affected.
**Tracking:** DC-123 (backlog) — restore dashboard visualization and TTS relay.

## Multiverse Adventure Pipeline (Phase 1.6) — DISCARDED

**Status: DISCARDED (2026-04-28).** The entire lobby-based pipeline has been abandoned. See "Adventure Design in World" above for the replacement architecture.

**Why discarded:**
- Lobby Matrix was an empty shell with no real utility.
- Per-adventure worlds added unnecessary complexity (Multiverse management, world switching, player teleportation).
- Relocatable blueprints were over-engineered — coordinates chosen by walking the terrain are more natural and flexible.
- The compiler (datapacks + schematics) was never implemented and would have required massive effort for marginal gain.

**What survived:**
- Blueprint JSON format (phases, triggers, events, sensors, flags).
- Dashboard (browse, edit, save blueprints).
- Shared validation registry (`minecraft-registry.json`).
- `mc_story` tools (`setup_sensors`, `poll_sensors`, `advance_phase`, etc.).

**Replaced by:** DC-85 through DC-91 (in-world blueprint engine).

## Current State

**Phase 1 is complete.** All Hermescraft primitives have been migrated and improved.
**DC-105 (Unified Social Routing) is DONE** — merged to main (2026-05-02).
**DC-112 (Single-LLM Architecture) is DONE** — gateway owns all cognition, loop is heartbeat injector. Merged to main via `feat/dc-112-daemoncraft-gateway` (2026-05-02).
**DC-123 (Dashboard/TTS regression) is BACKLOG** — dashboard panels empty after DC-112, TTS relay broken.
Companion and Landfolk modes are **legacy test modes** and will be deprecated.

**Agent model:** MiniMax-M2.7 (via minimax provider, anthropic_messages api_mode for prompt caching).

**Active development (2026-05-03):** Debugging session with ChatGPT identified that Steve's mc_* tools fail because they resolve the bot API URL from a stale process-global `MC_API_URL=3002` (from `hermes-gateway.service` Environment=) instead of the active cast's port (3001). Session routing, profile selection, and model/provider are all correct. The tools ARE present in the LLM session. The bug is endpoint resolution. No code changes made yet — architectural path needs discussion.

**Sandbox mode:** ENDED (2026-05-02). Deploy will be updated via `hermes update` instead of manual file copying.

**Current active cast (2026-05-03):** `companion` (Steve) — agent_loop running manually on port 3001 with MiniMax-M2.7 via `minimax` provider + `anthropic_messages` api_mode. `daemoncraft-cast.service` is stopped for debugging.

## Known Issues / Next Steps

- **Endpoint resolution bug (ACTIVE — 2026-05-03):** Steve's mc_* tools hit stale port 3002 because `minecraft_tools.py` reads `MC_API_URL` from a process-global env var set in `hermes-gateway.service`. The active cast runs on port 3001. There are three competing truths for bot endpoint:
  1. `~/.config/daemoncraft/cast.conf` + profile `~/.hermes/profiles/steve/.env` (port 3001 — correct for current cast)
  2. `~/.hermes/config.yaml` `platforms.daemoncraft.extra.bot_api_url` (port 3001 — correct but not read by tools)
  3. `hermes-gateway.service` `Environment=MC_API_URL=3002` (port 3002 — stale, but this is what tools actually use)
  `minecraft_tools.py` is untracked in both repos (ad-hoc drop-in). `check_minecraft_available()` returns True even on connection failure. Architectural fix needed: derive bot URL per DaemonCraft session, not from global env var.
- **Quest phase engine**: Implemented. Phases have triggers, objectives, and `timeout_minutes`. `record_activity` resets timer. `check_timeout` auto-abandons stale quests. Players can retake or restart.
- **Scoreboard sensor architecture**: Consolidated 3-command API. `setup_sensors` creates scoreboards + registers metadata. `poll_sensors` batch-checks all sensors (runs poll_command for dummies, reads native scores for real criteria, auto-resets fired sensors). `cleanup_sensors` removes all. Bot server.js has native `GET /scoreboard?objective=X&player=Y` endpoint via Mineflayer API. `check_score` uses this endpoint instead of parsing chat.
- **Sensor persistence**: `active_sensors` tracked in `story.json` as `{name, criterion, poll_command}`. `setup_sensors` is idempotent — safe to call on every startup. State survives server/agent restarts.
- **Vision/screenshots**: ✅ **RESUELTO (DC-57)**. Reemplazamos `mine-photo` (corrupto) por `prismarine-viewer` + `puppeteer` con flag `--use-angle=swiftshader`. WebGL headless funciona. Endpoint `GET /screenshot` y `mc_perceive(type="screenshot")` operativos. `vision` toolset re-habilitado en `rolemaster.yaml`.
- **Standby mode**: ✅ **IMPLEMENTADO**. `python3 -m agents.daemoncraft pause rolemaster [Pamplinas]` pausa turns autónomos sin desconectar el bot del juego. `resume` vuelve a activar. Controlado via archivo `STANDBY_FILE` + señal `SIGUSR1`.
- **Pamplinas status**: `daemoncraft-cast.service` está detenido. Steve (companion) es el agente activo en debugging.
- **No truncation policy**: Chat lines > 240 chars son REJECTED con visible error (`CHAT TOO LONG — NOT SENT`). Todos los agentes aprenden brevedad via prompt (máx 180 chars por línea, eficiencia poética). El `final_response` del modelo va directo al chat; Hermes separa nativamente tool_calls de content.
- **Verify before narrate**: SOUL rule — Pamplinas debe verificar mundo con `mc_perceive` antes de describir objetos/entidades.
- **Narrative branching**: SOUL documenta exits success/failure/surrender/chaos por fase. `get_events` tool lee historial reciente.
- **Sensor consequence detection**: Native criteria tipo `minecraft.mined:minecraft.stone_bricks` detectan cuando jugadores rompen estructuras de quest.
- **mc_command entity validation**: Pamplinas invocó `raven` (no existe). Pendiente: pre-flight de validación de entidades contra registry.
- **Screenshot speed**: prismarine-viewer + puppeteer tarda ~4-5s por screenshot (aceptable para verify-before-narrate).
- **Baritone movement**: Postponed. Pathfinder actual cubre goto/follow básico.
- **Scene-graph correction**: Postponed. `mc_scene` provee summary fair-play.
- **Human Design integration**: User quiere transits, personality archetypes, variable lives. Listo para empezar.
- **Companion mode deploy**: Config existe pero no testeado en servidor live.
- **Landfolk mode**: SOUL existe pero necesita testing post-civilization.
- **Role Master mode**: Bot tiene operator privileges. `mc_command` y `mc_story` live. Polish pendiente en brevity enforcement y command validation.
- **Multi-bot self-echo fix**: `agent_loop.py` lee `MC_USERNAME` del env. Funciona perfecto para single-bot casts. Limitación: en multi-bot, Bot A puede ver chat de Bot B como mensaje de jugador.
- **Language responsiveness**: Todos los SOULs instruyen a responder en el idioma del jugador.

## Archived Reference

The old `hermescraft-profiles` project is archived at `~/ArchivedProjects/hermes-profiles-archived/`.
It is **for reference only** — extract code primitives, prompts, behavior skills, but do NOT revive its ad-hoc architecture.

## Key Files

- `~/Projects/DaemonCraft/MEMORY.md` — this file
- `~/wiki/projects/DaemonCraft/index.md` — project wiki index
- `~/wiki/projects/DaemonCraft/notes/migration-plan.md` — migration plan
- `~/wiki/projects/DaemonCraft/notes/hermescraft-profiles-plan.md` — profile architecture
- `~/ArchivedProjects/hermes-profiles-archived/AGENTS.md` — archive warning

---

## Migrated from Global Memory

The following observations were moved from global memory because they are specific to DaemonCraft/hermescraft development.

### Process Management Requirements

User preference: MUST have clean process management for Minecraft bots. Every bot needs: PID file, start/stop/status script, no orphaned processes. Must verify before assuming a bot is running. Must kill all bot processes before creating/recreating agents.

User preference: When modifying agent creation/setup code, ALWAYS discard and recreate the agent profile from scratch to ensure we're testing the latest code.

### Architecture Notes

DaemonCraft architecture: agents/ layer replaces old bots/. Uses Hermes native profile system with --clone for templates. Templates stored as '<name>-template' Hermes profiles. Prompts live in agents/prompts/.

Critical fix discovered: TUI mode uses platform_toolsets.cli, not just toolsets. Must add 'minecraft' to both toolsets AND platform_toolsets.cli for agents to work in interactive mode.

### Backward Compatibility Policy (Testing Phase)

**NO agregar fallbacks ni soporte backward-compatible mientras estamos en fase de testing.** El formato de `story.json`, estructura de scoreboards, schemas de blueprints, y cualquier dato persistente bajo nuestro control DEBE mantenerse en un único formato soportado.

- Si cambiamos el formato de algo (ej: `active_scoreboards` de strings a dicts), NO agregar código que detecte y maneje ambos formatos.
- Borrar los datos viejos y regenerar desde cero es la solución correcta durante testing.
- La migración de datos será implementada como un paso explícito de migración (script o utilidad) solo cuando el proyecto esté en producción real con usuarios reales que no puedan perder su progreso.
- **Regla:** Un solo formato soportado. Código limpio. Sin `isinstance` checks para formatos legacy.

### World Type: Flat vs Normal

**Critical rule for itzg/minecraft-server:** The `LEVEL_TYPE` env var in `docker-compose.yml` controls world generation.

| World Type | docker-compose.yml | Result |
|---|---|---|
| **Normal** (default) | Remove `LEVEL_TYPE` entirely | `level-type=default` in server.properties |
| **Flat** | `LEVEL_TYPE: "FLAT"` | `level-type=flat` in server.properties |

**Procedure to change world type:**
1. Edit `docker-compose.yml` — add or remove `LEVEL_TYPE`
2. Stop and remove container: `docker stop daemoncraft-minecraft && docker rm daemoncraft-minecraft`
3. Delete world data: `rm -rf server/data/world server/data/world_nether server/data/world_the_end`
4. Recreate container: `docker compose up -d minecraft`
5. Wait for healthy: `docker inspect --format='{{.State.Health.Status}}' daemoncraft-minecraft`

**Common pitfall:** Setting `LEVEL_TYPE: "DEFAULT"` or `LEVEL_TYPE: "NORMAL"` does NOT work as expected. The itzg/minecraft-server image writes `level-type=default` to server.properties, but Paper/Purpur may interpret this incorrectly and still generate flat terrain. The only reliable way to get normal terrain is to **omit `LEVEL_TYPE` completely** so the image uses its internal default.

**Another pitfall:** Using `docker start` instead of `docker compose up -d` after changing docker-compose.yml will restart the old container with the OLD environment variables. Always remove and recreate the container.

### No Truncation Policy

**NUNCA truncamos salidas del modelo.** Si una línea de chat es demasiado larga para el protocolo de Minecraft, la RECHAZAMOS con un error visible para que el modelo la corrija. Si un `mc_command` excede el límite del protocolo, el servidor echa al bot (error visible). El modelo debe aprender a generar contenido del tamaño correcto a través del prompt, no a través de post-procesamiento silencioso.

- Chat: el prompt enseña "máximo 180 caracteres por línea de chat". Si excede, `_send_chat_chunks` loguea `CHAT TOO LONG — NOT SENT`.
- Comandos: el prompt enseña "Command Exactness — se envían EXACTAMENTE como los escribís". Si exceden el límite del protocolo, el servidor disconecta al bot.
- **No hard caps, no truncation, no fixes silenciosos.** Errores visibles = aprendizaje del modelo.

### Hermescraft → DaemonCraft Transition

The deprecated hermescraft-profiles project has been archived to ~/ArchivedProjects/hermes-profiles-archived (moved from ~/Projects/hermescraft-profiles on 2026-04-23). The active Hermes install at ~/.hermes/hermes-agent had stale uncommitted symlinks and modifications from this old project (minecraft gateway platform, mc_* toolsets, etc.) which were cleaned up. Current DaemonCraft architecture uses agents/ layer with Hermes profiles/templates, not the old gateway platform approach.

User considers hermescraft behavior skill files (minecraft-building.md, minecraft-combat.md, minecraft-farming.md, minecraft-navigation.md, minecraft-survival.md) as 'primitives' that should be migrated alongside code. When they say 'bring missing primitives from hermescraft', they include these agent behavior guides, not just code endpoints.

### Agent Loop Patterns

DaemonCraft uses a persistent agent architecture where each Minecraft bot is driven by an AIAgent in a continuous loop via a dedicated `agent_loop.py` script. The cast (Landfolk, Civilization, etc.) is managed as a systemd user service (`daemoncraft-cast.service`). Agents are configured with the `messaging` toolset and the `HERMES_SESSION_PLATFORM=telegram` environment variable to enable cross-platform communication and screenshot delivery. All bots/agents must have clean process management (PID files, start/stop/status logic) to prevent orphaned processes. Profile templates for agents must be kept restricted to prevent security risks like rogue shell execution.

Bot Reconnect Race Condition: When using Mineflayer bots with an auto-reconnect strategy, 'bot.quit()' inside a 'createBot' function can trigger the 'end' event listener of the old bot, scheduling a competing (duplicate) reconnect timeout. Use 'bot.removeAllListeners()' before 'bot.quit()' to prevent infinite join/leave cascades.

Agent Loop Token Load Pattern: Sustained loops (e.g. 7 agents every 30s) can quickly hit rate limits or exhaust token quotas when using high-end models like kimi-k2.6, especially as history accumulates. Use MiniMax-M2.7 or similar via configured providers for autonomous behavior loops to preserve coding-tier quotas.

Minecraft Agent Error Feedback Pattern: Agents require actionable tool errors to prevent repetitive failure loops. Error messages should include inventory hints (e.g. "No X, you have Y") and specific geometric blockers (e.g. "target space occupied by Z", "no adjacent support"). Behavior skills should include "Pre-flight Checks" sections to instruct agents to verify state before calling physical tools.

The agent loop for Minecraft bots ('agent_loop.py') maintains a 30s interval but lacks aggressive backoff or jitter, which previously caused token quota exhaustion on expensive models like kimi-k2.6 when running a 7-bot cast. Usage optimization (switching to MiniMax-M2.7) and aggressive history trimming are preferred to preserve coding tokens.

DaemonCraft Planning Architecture: User prefers persistent, long-term planning over reactive loops. Agents should use a structured Goal & Task system (JSON-based) that persists across turns. Explicit support for a 'Rolemaster' mode (Game Master agent driving narrative/world events). Interest in using Lattice (or a similar dashboard) for real-time visibility and inter-agent coordination of these plans. Strategy roles should be assigned to specific agents for collective orchestration.

---

## Migrated from Global Memory (2026-04-28)

The following observations were consolidated from global agent memory because they are specific to DaemonCraft development.

### Server Platform

DaemonCraft server runs **Purpur 1.21.11** (migrated from Forge 1.20.1).
Plugins: Geyser-Spigot, Floodgate, WorldEdit Bukkit, Citizens2, Denizen.
Java + Bedrock crossplay via Geyser plugin (no standalone container).
Mineflayer auto-detects version.

### Development Principles

**Empirical verification first:** When proposing an architectural approach, test that the underlying mechanism actually works before designing tools around it. Example: verify the bot can execute Minecraft commands before building quest logic that depends on command execution. Do not assume capabilities based on code inspection alone.

**Architecturally correct next step:** Understand dependency chains and execute them in order without step-by-step confirmation. Example: cast config needs prompt file, prompt file needs directory, tools need registry entries — create them in that order autonomously.

**Verifiable state-based triggers:** User strongly prefers scoreboard sensor architecture (dynamic `/execute` polling + `check_score`) over proximity assumptions or invisible command blocks for quest triggers. No hardcoded datapack functions per quest.

**Direct chat:** The model's `final_response` (assistant content) goes directly to Minecraft chat. Hermes natively separates `tool_calls` from `content` at the protocol level. No prefixes, no filters, no `SAY:` format. Chat lines > 180 chars are rejected with visible error (`CHAT TOO LONG — NOT SENT`). All agents learn brevity via prompt, not silent fixes.

**Pamplinas mode:** Pamplinas is permanently in creative mode, never asks for materials, never checks inventory. Teleport is the movement fallback.

**Biome/entity/block selectors:** Hard fields like biomes, entity types, block IDs, and scoreboard criteria must use constrained selectors/dropdowns (not free-text editable). This aligns with DC-73 (shared validation registry).

### Movement & Pathfinding

**CRITICAL: `allowSprinting` must be `false`**

Mineflayer-pathfinder v2.4.5 has a bug where `allowSprinting = true` causes the bot to get stuck on 1-block steps. The bot bumps into the block edge and cannot jump. This happens on Purpur 1.21.11 (and likely other servers). The exact symptom matches GitHub issue #358:

> *"bot can jump on a block only when sprinting is disabled. otherwise it is stuck at height (Y) somewhere between the blocks."*

**Fix:** In `agents/bot/server.js`, set `moves.allowSprinting = false` in the pathfinder `Movements` configuration. `allowParkour` can remain `true`. `canDig` can remain `true`.

**Verification:** Tested 2026-04-28 — with `allowSprinting = false`, the bot climbs stairs, follows players, and navigates terrain correctly in both survival and creative mode.

**Note:** Creative flight is a separate issue. The bot does not know how to hold jump to fly upward in creative. It will try to jump repeatedly and then pillar-build. This is documented but not yet fixed.

---

## TTS / Voice Integration Project (DC-94 — absorbed into DC-105)

**Status: SUPERCEDED by DC-105.** The gateway adapter, TTS integration, and dashboard voice mode were all merged into the DC-105 branch. The TTS hook and dashboard toggle remain functional. See DC-105 section above for current architecture.

**Voice mode config:** `~/.hermes/gateway_voice_mode.json` contains `{"daemoncraft:overworld": "all"}` — TTS is active for all messages in the overworld.

**What survives from DC-94:**
- Gateway adapter (`gateway/platforms/daemoncraft.py`) — extended in DC-105 with bot filtering and event consumption
- TTS hook (`send_voice()`) — unchanged
- Dashboard voice toggle + audio player — unchanged
- Deduplication logic — unchanged
- Voice config in `casts/rolemaster.yaml` (edge / es-MX-JorgeNeural)

### DC-94 Debugging Findings (moved from global memory)

- Claude CLI stores credentials in `~/.claude/.credentials.json` but will NOT auto-login in non-interactive mode even if the file exists. The session must be explicitly established via interactive `/login` first.
- After login, `--print` works reliably in non-interactive `terminal()` calls.
- The `claude` binary in `~/.npm-global/bin/` may differ from the one in `~/.local/bin/` (check `which claude`). Ensure PATH priority if there are conflicts.
- Do NOT pipe large diffs via stdin to `claude -p` without `--dangerously-skip-permissions` or the tool approval prompts will hang the subprocess.
