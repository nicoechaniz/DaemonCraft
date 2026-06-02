# DaemonCraft Project Memory

## Session 2026-06-01/02 — L4 Anti-Loop, Lab Mode, Cast Reset, Session ID Collision

### Problem observed
McCompaii L4 entered 50-100 iteration turns attempting to resolve impossible objectives (e.g. move north to unreachable terrain) by trying many variants of the same action. Bot appeared frozen for 10-30 min per turn. A separate kimi-k2.6 session iterated up to 100 tool calls per turn, mostly calling `mc_chat` to spam `/setblock` and `/fill` commands to the bot chat instead of doing real work.

### Root cause (working hypothesis)
The L4 receives `last_judge: outcome=stuck` from failed tool calls but treats it as just another input rather than a terminal signal. The judge is working, the L4 is ignoring it. No software enforcement says "stuck on the same objective for N tool calls, pivot." L4 cap of 100 iterations is too high (8-50 min per turn).

### Fixes applied
1. **`/filter` in daemoncraft.py:_handle_chat_entry** — drop chat messages starting with `/` from L4 injection. Operator commands still work, just don't wake the L4. (commit pending in workspace)
2. **Watchdog anti-loop in daemoncraft.py:_classify_heartbeat_event** — wake_up L4 if same (action, status, elapsed//30) signature repeats for N heartbeats (default 4) OR task.status=done with elapsed_s > 600s. Configurable via `task_loop_threshold` and `task_stale_seconds` in `~/.hermes/config.yaml`. **Commit `2aaef8fb4` on hermes-agent `main`.**
3. **`[System note:` filter in daemoncraft.py:handle_message** — in lab mode, strip the re-entry note prefix from messages. Autonomous mode keeps the note.
4. **Cast-reset sessions on boot in daemoncraft.py:cmd_daemon** — when the cast restarts a bot for the first time in a cycle, delete any persisted DaemonCraft L4 sessions from the state.db (with backup to `state.db.cast-reset-*.bak`). Prevents stale context rehydration.
5. **Drop heartbeats in lab mode in daemoncraft.py:_handle_heartbeat_context** — early return at the top of the handler when `mode=lab`. The L4 session is only created when a real user turn arrives (chat, dashboard event, explicit operator action). Tested: 0 sessions after 15s of heartbeats in lab.
6. **Session epoch microsecond in daemoncraft.py:__init__** — `_session_epoch: int = int(time.time() * 1_000_000)`. Reduced theoretical collision risk but **did not actually solve the ID collision** because `build_session_key` (gateway/session.py:648-660) builds keys using `group_sessions_per_user=True, thread_sessions_per_user=False`, and when thread_sessions_per_user=False, the participant_id (which includes the epoch) is dropped from the key. So the key doesn't change between restarts. The cast-reset (#4) is the real solution to the persistence problem.

### McCompaii SOUL updates
- `~/.hermes/SOUL_daemoncraft.md`: removed `deathpoint` from valid `mc_move` actions list, added "What I Never Do (Hard Bans)" section prohibiting death-as-tool and looped-narration, added "Anti-Loop Watchdog — Three-Turn Reset" section. **Not yet committed.**
- `~/.hermes/profiles/mccompaii/SOUL.md`: same patches in "Death and Rebirth" and "What I Never Do" sections. **Not yet committed.**

### Quest engine cleanup
- `~/.local/share/daemoncraft/rolemaster/story.json` had `active_blueprint=el-codigo-que-suena` with sensor `dqs_broke_crying` (crying_obsidian). Backup at `rolemaster/story.json.disabled-1780371580.bak`. Set to `active_blueprint=null, phase=null, active_sensors=[]`. The quest engine was reading this every 7s via rcon (causing the `rcon-cli scoreboard players get CompAII dqs_broke_crying` calls visible in journal). Now idle.

### Session ID collision investigation
- The session_id `20260601_122151_89363112` is reused on every gateway restart because the session_key doesn't include the epoch (see #6 above).
- `source='unknown'` in state.db for this session — the agent_loop (L3) is creating the session with source `unknown` instead of `daemoncraft`. Probably an artifact of the agent_loop's source reporting. Doesn't affect functionality but worth investigating later.

### Kanban
- Created `t_436909c6` — L4 anti-loop: pivot on stuck judge, don't thrash. Investigation plan + proposed fix documented.

### HMK
- Entry `chapter_id=48` in shelf `mc-episodic`: "2026-06-01/02 McCompaii L4 100-iter thrash turns + fixes"

### Files modified (uncommitted as of session end)
- `~/Projects/hermes-agent/gateway/platforms/daemoncraft.py` — 5 changes (filter, watchdog, system note filter, drop heartbeats, microsecond epoch)
- `~/Projects/DaemonCraft/agents/daemoncraft.py` — cast-reset sessions on boot
- `~/.hermes/config.yaml` — added `task_loop_threshold: 4` and `task_stale_seconds: 600` under `platforms.daemoncraft.extra`
- `~/.hermes/SOUL_daemoncraft.md` and `~/.hermes/profiles/mccompaii/SOUL.md` — anti-loop sections

### End-of-session test environment
- Mode: `lab`
- L4 sessions: 0 (lab drop heartbeats working)
- Bot: alive in (629, 124, -325), health 20, surface
- Quest engine: idle
- All services active: `daemoncraft`, `daemoncraft-cast`, `hermes-gateway`, `embodied-service`

### Next: software enforcement of pivot
The prompt-level and software-level fixes are still TODO (kanban t_436909c6). When judge.outcome=stuck fires 3× consecutively with the same target, force the L4 turn to terminate with a system message. Also need to test that the watchdog signature bucketing works in practice (current bucketing on elapsed//30 may not catch the actual thrash pattern).

## Session 2026-05-31 — McCompaii Profile, Autonomous Mode, LLM Visibility

### McCompaii — Minecraft Embodiment Profile
- Created Hermes profile `mccompaii` at `~/.hermes/profiles/mccompaii/`
- McCompaii = CompAII's daimon in Minecraft. Inherits core identity (present moment, Nico relationship, beacons) but only knows Minecraft domain.
- SOUL.md (~284 lines): PRIME DIRECTIVE, body architecture (L1-L4 with gAndy as L3), six-step explore cycle, death/rebirth protocol, save points, light as signature, regional character palettes, tools reference, practical wisdom.

### daemoncraft.py Gateway Fixes
- **Profile SOUL loading**: `_handle_heartbeat` now loads `SOUL.md` from `source.profile`'s profile directory and passes as `channel_prompt` → injected into system prompt (gateway/run.py:16228).
- **Normalize bug**: Profile names are lowercased. Directory must be lowercase (`mccompaii` not `McCompaii`).
- **Heartbeat simplification**: Removed WAKE UP/trigger classification, action history, massive hostile lists. Now: `[Turn]` body state, filtered hostiles (close <5m, near 5-20m top 3, else "beyond 20m"), `[Cycle]` action prompt.
- **Idle throttle**: Changed from 90s to 40s for faster debugging.
- **SOUL logging**: First 5 + last 5 lines + count, not full 21K chars.

### toolsets.py
- Added missing tools to minecraft toolset: `mc_macro`, `mc_interoception`, `mc_bit`, `mc_plan_decompose`, `mc_submit_plan`, `mc_start_quantified_intent`.
- Added `embodiment` toolset with `embodied_plan`.
- Total: 20 minecraft tools + 1 embodiment tool.

### LLM Response Issue (UNRESOLVED)
- Session `20260530_231543_5f6353` persists across restarts — same session key, same system prompt cached.
- McCompaii's PRIME DIRECTIVE misinterpreted: "I never respond with text alone" → LLM responds "*(silencio — obedeciendo la orden de no spammear texto ni tools)*" 
- `tool_turns` accumulates synthetic injections (109+) but LLM never initiates own tool calls.
- Need to fix PRIME DIRECTIVE wording to force tool use, not silence.

### Scripts
- `llm-verbose-log.sh`: Full request/response log with timestamps. Shows gAndy Ollama calls, Hermes prompts, chat messages.
- `watch-all.sh`: Layer 4 now shows LLM response text from /agent/log + turn summaries.

### Embodied Service Fix
- `index.js`: verification log EROFS error fixed — creates directory before writing, silences EROFS.

### Files Modified
| File | Change |
|------|--------|
| `agents/SOUL-lab.md` | Added "Autonomous Mode — Living in the World" section |
| `agents/embodied-service/index.js` | mkdir before verification log, silence EROFS |
| `scripts/watch-all.sh` | Layer 4: LLM response text, turn summaries, bot log extraction |
| `scripts/llm-verbose-log.sh` | NEW: full prompt/response log with timestamps |
| `~/.hermes/hermes-agent/gateway/platforms/daemoncraft.py` | Profile SOUL loading, heartbeat simplification, 40s throttle, SOUL logging |
| `~/.hermes/hermes-agent/toolsets.py` | Added mc_macro, mc_interoception, mc_bit, mc_plan_decompose, mc_submit_plan, mc_start_quantified_intent, embodiment toolset |
| `~/.hermes/profiles/mccompaii/SOUL.md` | McCompaii full identity + autonomous drive |

## Session 2026-05-30 — Major: Two Houses, Pathfinder Fixes, Orchestrator Verify, Persistent Autonomous

### State at session end
- **Tag**: v0.4.0-best-state (world-aware branch, 12+ commits)
- **Two houses built** in mesa: House 1 (X:548-555, Z:-336 to -329), House 2 (X:562-569, Z:-336 to -329)
- **Controller mode**: persistent autonomous (both agent_loop.py and server.js default to "autonomous")
- **Bot gear**: full netherite armor + axe, cooked_beef 37
- **Orchestrator**: running with real verify conditions against bot API

### Key fixes delivered
1. **Card F (t_c518b077)**: Auto-cancel gAndy before new embodied_plan. `_cancel_bot_task()` in embodied_plan_tool.py sends fire-and-forget POST /task/cancel before every intent.
2. **Stuck re-entry guard**: `_handlingStuck` flag prevents concurrent `_handleStuck` calls cancelling each other's mining.
3. **Head-height diagonal guard**: `getMoveDiagonal` now rejects diagonals where cardinal blocks at y+1 are physical. Prevents shoulder-clipping into leaves.
4. **Orchestrator verify fix**: `sync_progress` now calls `_verify_condition()` against bot API before marking sub-plans done. New `/block` endpoint on bot server. Previously blindly trusted executor=cleared.
5. **Persistent autonomous mode**: Both agent_loop.py and server.js default to "autonomous". Survives restarts.

### Build patterns learned
- fill_volume only fills AIR gaps — doesn't replace existing blocks
- mine_block (gAndy) mines globally — not within footprint coordinates
- Previous_error retry with correct block name works
- PlanManifest verify types must be lowercase
- Orchestrator needs autonomous mode — but dispatches still work in lab mode

### HMK Memory Shelves (populated this session)
- mc-episodic: two-houses-built-world-aware-branch
- mc-social: NicoElViejoGamer
- mc-skills: building-patterns-world-aware, hmk-memory-update-discipline
- mc-places: house-1-west-terracotta, house-2-east-yellow-terracotta
- Rule: ONE authoritative entry per topic, replace or archive old versions

### SOUL templates updated
- SOUL-base.md §10: HMK Minecraft shelves documentation
- SOUL-lab.md: short HMK reference
- SOUL_daemoncraft.md: full HMK with cross-linking rules and writing discipline

### gAndy building observations
- Works well with fill_volume for walls (air targets)
- Struggles with mine_block (global targeting)
- Needs precise coordinate format: [X,Y,Z] not X:Y:Z
- previous_error with correct block name enables material substitution
- Timeout is HTTP only — gAndy continues executing in background
- Orchestrator dispatched walls successfully (yellow/red/orange terracotta mix)

## Session 2026-05-30 — Auto-Cancel Fix (t_c518b077)

### Card F: Auto-cancel gAndy plans on new embodied_plan call
- **Problem**: second `embodied_plan` timeout because bot's `currentTask` still `running` from fire-and-forget actions of previous plan
- **Fix**: `_cancel_bot_task()` in `embodied_plan_tool.py` (hermes-agent feat/daemoncraft) — sends `POST /task/cancel` to bot before every new intent (fire-and-forget, 2s timeout)
- **Deployed**: `~/.hermes/hermes-agent/tools/embodied_plan_tool.py`
- **Kanban**: t_c518b077 (done)

## Session 2026-05-30 — Scene Verification Framework + Macro Tools (world-aware branch)

### Judge Mailbox Expansion (May 30, late session)
- **Problem**: Single-slot judge mailbox was drained by L3 agent_loop before L4 could read it
- **Solution**: Ring buffer (max 10) with initiator field (l2_runner, l3_loop, l4_agent)
- L3 reads `/judge/pending` and only consumes entries with initiator=l3_loop, leaves L4 entries
- Gateway auto-consumes L4 entries on wake_up via `/judge/consume`
- New endpoints: GET `/judge/pending`, POST `/judge/consume`
- `_fmt()` in minecraft_tools.py now includes `_judge` field in output
- Files: server.js (ring buffer + endpoints), agent_loop.py (pending + selective consume), daemoncraft.py (auto-consume), minecraft_tools.py (_fmt judge)
- Kanban: t_e9c77126, t_8fbb9157 (completed)
- mc_move SOUL fix: `action="goto"` is REQUIRED — SOUL_daemoncraft.md updated

### Construction Reliability Fixes (May 30, final session)
- **place_fill lied**: reported "36/36 placed" but only 9 materialized. Root cause: `_genericPlace` can silently fail; `place_fill` had no verification unlike `place()`.
- **Fix**: Added 200ms wait + `blockAt()` verification in `place_fill`. Now reports "did not materialize" for blocks that silently failed.
- **Bot-in-volume detection**: Both `place()` and `place_fill` now refuse if bot is standing inside the target area. Clear error: "Refusing: you're standing there. Move X first."
- **SOUL rules**: Construction Safety section added to SOUL_daemoncraft + backported to SOUL-base — never build where you stand, verify position first.
- **6x6 base successfully built**: 36/36 orange_terracotta, verified with mc_bit. Takeaway: `fill` → `mc_bit verify` is the mandatory pattern.
- **mc_build place** silently fails (no feedback). Underlying issue: `_fmt` judge change not picked up by running session (module caching).
- Commits DaemonCraft: 347452f (verify fill), 8077a9a (bot-in-volume), e525664 (SOUL rules)

### Branches
- **`feat/motion-refactor`**: macro tools (staircase, spiral, tunnel) + stuck counter fix
- **`world-aware`** (12 commits): scene verification, judge, 3D perception, surface detection, tunnel fixes

### What we built

**Macro Tools** (`feat/motion-refactor`, 3 commits):
- `POST /macro` endpoint → `climbStaircase()`, `climbSpiral()`, `digTunnel()`
- Hermes tool: `mc_macro(macro, direction?, target_y, steps_per_side?, distance?)`
- Escape protocol: `tunnel` into wall → `spiral` up

**Scene Verification Framework** (`world-aware`, 12 commits):
- `GET /scene` → structured + narrative perception (Grok build)
- `blocks_above` field: y+1, y+2, y+3 above bot (catches tree canopies, ceilings)
- `is_surface`: 96-block air column + 2 open cardinals (distinguishes deep holes from surface)
- `judgeAction()`: wraps goto/dig/place/fill/attack/collect/follow, captures before/after position, classifies outcome (success|partial_step_up|blocked|no_progress|displaced|preempted|error)
- `GET /judge/last` — mailbox for last action verdict
- Heartbeat enrichment: `scene_graph` + `last_judge` in body_session
- Trust hierarchy in SOUL-base.md §2.6: scene_graph > judge
- Lab mode guard in agent_loop.py

**Key fixes:**
- Stuck counter: save/restore `_stuckRestartCount` across `goto()` calls in `_handleStuck`
- Tunnel direction: signed delta check (was counting any movement as success)
- Tunnel mining: now clears feet-level block too (was only y+1 and y+2)
- Surface detection in macros: uses same 96-block + 2-cardinal criteria as /scene
- `fill` added to judgeIntents

### Key learnings
1. **Tool responses lie.** "Placed 16/16" ≠ 16 visible blocks. "Navigation cancelled" ≠ no movement. Always verify with mc_bit/mc_perceive.
2. **scene_graph is a single Y slice.** It tells you what's at your current Y, not above. Always scan full volume (y-1 to y+5) before building.
3. **gAndy times out if already executing.** Earlier plan wasn't cancelled before re-calling. Need auto-cancel (card t_c518b077).
4. **3D perception is essential.** Built a house through a tree canopy because I only scanned ground level. `blocks_above` now catches this.
5. **The judge works but needs richer taxonomy.** Currently success|blocked|no_progress|etc. Forum review recommended wrong_axis, overshot, partial, displaced, preempted (not yet implemented).
6. **Position crouch on backstep.** Old recovery logic had it; stripped in refactor. Bot falls off edges. Side-quest.

### Git state
- `feat/motion-refactor`: 08200ef (macros) + dec95cd (SOUL backport) + c673f95 (combat fix)
- `world-aware`: 12 commits from 9c03cb6 (lab guard) to 15bc98b (judge fill)
- Hermes-agent `feat/daemoncraft`: be7c723d5 (mc_macro tool)

### Files modified (world-aware)
- `agents/bot/server.js`: /scene, /judge/last, judgeAction(), macros, surface detection
- `agents/agent_loop.py`: lab mode guard, heartbeat scene_graph + last_judge projection
- `agents/SOUL-base.md`: 3D perception rule, trust hierarchy §2.6, macro tools
- `agents/bot/lib/motion-controller.js`: stuck counter fix
- `~/.hermes/SOUL_daemoncraft.md`: macro tools, mc_bit legend, 3D perception rule

### To continue after /new
- Test escape protocol: tunnel into wall → spiral to surface
- Test building with proper 3D scanning
- Implement forum recommendations: richer judge taxonomy, 3×4×3 grid in scene_graph
- Fix gAndy auto-cancel (card t_c518b077)
- Side-quest: crouch on backstep
- Kanban: 5 active cards under epic t_ca3d27e9

### Scenegraph legend (mc_bit full format)
`#`=stone/ore/andesite, `T`=terracotta, `a`=air, ` `(space)=air/transparent,
`G`=grass_block, `d`=dirt, `L`=leaves, `l`=log, `.`=short_grass, `,`=leaf_litter,
`w`=planks, `~`=water, `!`=lava

## Macro Tools — 2026-05-30

Three pre-canned multi-step skills available via `POST /macro` (bot server) and `mc_macro()` (Hermes tool):

| Macro | Params | Pattern | Code |
|-------|--------|---------|------|
| `staircase` | `direction` (W/E/N/S), `target_y` | 3-block diagonal staircase upward. Stops at target_y or open sky. | `climbStaircase()` |
| `spiral` | `target_y`, `steps_per_side` (2=1-block center pillar) | Helical staircase, rotates 90° every N steps. Stops at target_y or open sky. | `climbSpiral()` |
| `tunnel` | `direction`, `distance` (default 10) | 2-high × 1-wide horizontal tunnel. | `digTunnel()` |

**Escape protocol:** `tunnel` into wall → `spiral` up. Always prefer macros over manual step-by-step mining.

**Open-sky detection:** checks 3 blocks above bot for all air. Returns `stoppedEarly=true`.
**Step-up mechanism:** `motion.goto()` with `allowParkour=true`. Response "cancelled" is noise — verify position.
**mc_bit legend:** `#`=solid stone/ore, `T`=terracotta, `a`=air, ` `(space)=air/transparent.

**Files:**
- Bot: `agents/bot/server.js` (climbStaircase ~line 960, climbSpiral ~line 1060, digTunnel ~line 1195, /macro endpoint ~line 5050)
- Hermes: `~/Projects/hermes-agent/tools/minecraft_tools.py` (mc_macro tool ~line 2085, feat/daemoncraft branch)
- Commit DaemonCraft: `08200ef` on `feat/motion-refactor`
- Commit Hermes-agent: `be7c723d5` on `feat/daemoncraft`

## Session State — 2026-05-29 (Autonomous Play Setup ✅)

### What we achieved
- **Autonomous loop pipeline**: agent_loop → heartbeat → gateway WS → wake_up → CompAII session → mc_* tools
- Controller mode: `autonomous`
- Model: `deepseek-v4-flash` via `platforms.daemoncraft.extra.profile` (not set up, using default from systemd)
- **Gateway fix**: `DAEMONCRAFT_ALLOWED_USERS=system` added to systemd service Environment
- **Deploy fix**: `~/.hermes/hermes-agent` had corrupted minecraft_tools.py (merge conflict markers + line-number corruption). Reset to `origin/main`, re-merged `feat/daemoncraft` cleanly.
- **aiohttp fix**: Gateway venv was missing aiohttp — installed via `~/.hermes/hermes-agent/venv/bin/pip`

### Curriculum
- `~/.hermes/SOUL_daemoncraft.md` now includes "Autonomous Play — Minecraft Curriculum" section
- 6 tiers: Wood Age → Shelter → Mining/Iron → Diamond/Enchanting → Nether → The End
- Turn protocol: no plan → SET ONE NOW, then act. NEVER wait for a player.
- `mc_chat` announcements on tier progression for Nico to read later

### Wake-up prompt fix
- `gateway/platforms/daemoncraft.py` line 607: changed from "Decide ... or wait" to "START following your autonomous curriculum immediately. Take ONE concrete action now. Do not wait."
- Workspace: committed to `feat/daemoncraft`
- Deploy: `~/.hermes/hermes-agent` has the change live

### Verified circuit
- Gateway WebSocket connected to bot :3003 (PID visible via ss -tnp)
- Agent_loop sends heartbeats → gateway processes → DaemonCraft session wakes up
- CompAII autonomous session IS acting (verified via Minecraft chat messages)
- When Nico is nearby: follows him. When Nico is gone: curriculum kicks in.

### Files modified this session
| File | Change |
|------|--------|
| `~/.hermes/SOUL_daemoncraft.md` | Added Autonomous Curriculum section |
| `~/.hermes/hermes-agent/gateway/platforms/daemoncraft.py` | Proactive wake-up prompt |
| `~/.hermes/hermes-agent/tools/minecraft_tools.py` | Fixed merge conflicts (then reset) |
| `~/.config/systemd/user/hermes-gateway.service` | Added `DAEMONCRAFT_ALLOWED_USERS=system` |
| `~/.hermes/.env` | Added `,system` to DAEMONCRAFT_ALLOWED_USERS |
| `~/Projects/hermes-agent/gateway/platforms/daemoncraft.py` | Backported wake-up prompt |

### Service state (auto-starts on boot)
- `daemoncraft.service` → Minecraft server
- `daemoncraft-cast.service` → bot (node server.js :3003) + agent_loop.py
- `hermes-gateway.service` → gateway (WebSocket to :3003, Telegram, DaemonCraft)
- `embodied-service.service` → Gemma-Andy (:7790)

### Known issues
- Gateway logs daemoncraft platform at DEBUG level — don't expect WARNING/INFO in journal
- Memory full (9,942/10,000 chars) — needs cleanup
- `mc_plan` starts empty (goal: null) — curriculum now auto-creates it
- Wake-up prompt fix is in deploy but NOT committed to deploy's git (deploy is on `main` with merge)

### Git commits this session
- DaemonCraft `feat/motion-refactor`: `fix(agent_loop): executor resume, orchestrator clear, async dispatch, logging timestamps`
- Hermes-agent `feat/daemoncraft`: `fix(daemoncraft): proactive wake-up prompt — no plan → start curriculum`

---

### Fase 2: Quantified Intent Executor ✅
- **agents/plan_executor.py** (318 lines): QuantifiedIntentExecutor class
- **agent_loop.py**: executor_state in heartbeat, _check_executor_resume()
- **tests/test_plan_executor.py**: 19 tests passing
- Commit: 42ee3d5

### Fase 3: Plan Decomposition ✅
- **agents/plan_orchestrator.py** (310 lines): PlanOrchestrator class
  - validate_manifest: anti-hallucination guard (VerifySpec mandatory)
  - execute_plan: order + depends_on execution, escalation on failure
  - orchestrator_state in heartbeat (agent_loop.py)
- **agents/plan_schema.py**: SubPlan + PlanManifest dataclasses (to_dict/from_dict)
- **mc_plan_decompose tool**: registered in hermes-agent tools/minecraft_tools.py
- **tests/test_plan_orchestrator.py**: 10 tests passing
- Commit: e04ad69 (DaemonCraft) + hermes-agent feat/daemoncraft

### Code audit: Phase 1 verification ✅
- mutex_released → runnerEventBuffer: server.js:719-722
- runner_activity in heartbeat: agent_loop.py:366-387
- mc_interoception tool: minecraft_tools.py:1703-1707
- GET /interoception endpoint: server.js:3878-3942

### Epic t_a9399767 — COMPLETED
- Fase 1 (visibility): done (pre-session)
- Fase 2 (executor): done (42ee3d5)
- Fase 3 (orchestrator): done (e04ad69 + hermes-agent)
- Total: 3/3 child tasks; 29 tests passing
- Pending: end-to-end validation with live bot

### Commits on feat/motion-refactor
- e04ad69 feat(orchestrator): PlanOrchestrator + PlanManifest (Fase 3)
- 185941b docs: update MEMORY.md with Fase 2 + Fase 3 delegation
- 42ee3d5 feat(executor): QuantifiedIntentExecutor (Fase 2)
- 6bc928a docs: MEMORY.md pathfinder fixes + motion cleanup

---

## Session State — 2026-05-29 (Pathfinder Fixes Final + MotionController Cleanup)

### What we solved today
**Pathfinder-level fixes (mineflayer-pathfinder, persisted via patch-package):**
- `getMoveDiagonal` bounding-box guard: rejects diagonals where either cardinal block is solid
- `canSprintJump` disabled (`false && ...`) — sprint+jump completely removed
- Centering between nodes in `monitorMovement`: after arriving at a node, walks to block center (0.08 tolerance) before proceeding
- Clearance guard: computes `nearBlock` flag (solid block <0.65 ahead at feet/head), gates `canStraightLine(path, true)` with `!nearBlock`
- `getReached` kept at original `< 1` (reverted from `< 0.25` experiment)
- `allowSprinting = true` — sprint only on clear flat straight lines, walk+jump for everything else

**MotionController (our code):**
- `_walkToBlockCenter()`: runs at start of every `goto()`, `gotoNear()`, `follow()` — centers bot on block before pathfinding. Timeout 500ms, bails early if stalled.
- Fast-stuck detection: 200ms interval, 0.5m threshold, 200ms trigger. Fires in ~200-400ms.
- Stuck restart: sets session to REPLANNING, calls `goto()`/`follow()` again → triggers `_walkToBlockCenter()` → new path starts from centered position. Max 3 attempts.
- Recovery FSM completely stripped (-339 lines): `_doStepRecoveryFSM`, `_doLateralRecoveryFSM`, `_doMineRecoveryFSM`, `_pausePathfinder`, `_resumeGoal`, `_findNearestBodyBlock`, `_withControls`, `RECOVERY_STAGE` enum all removed. Placeholder comment left in `_handleStuck`.
- `_recoveryEnabled = false` kept as flag with documentation comment.
- `_classifyBlocked` and `_clearControls` preserved (used elsewhere).

**Key learning:** The FSM recovery (backstep + rotate + jump) was causing infinite loops because it measured success as `dy > 0.3 || moved > 1.0` — the bot would move sideways, "succeed", resume, get stuck again. The simpler approach (centering + restart) works better.

**Forum consultation (ia-bridge):** Claude, Codex, Gemini, Grok all identified `getReached` and `canSprintJump` as root causes. Consensus: disable sprint+jump, tighten `getReached`, don't touch prismarine-physics. Final solution follows consensus.

**BodyMutex / Reflex Layer Phase 1 status:** Fully implemented on disk — `mutex.js`, `action-registry.js`, `runner/thread.py`, endpoints in server.js, RunnerThread in agent_loop.py. `mutex_released` → runnerEventBuffer wired. `runner_activity` injected in heartbeat. `mc_interoception` tool available. Epic t_18006055 in triage pending end-to-end validation.

### Next: L2→L3→L4 Cross-Layer Coordination (t_a9399767)
Fase 1 already done. Next is Fase 2 (simple executor for quantified intents) and Fase 3 (plan decomposition). Delegate to Grok via ia-bridge /build.

### Kanban cleanup this session
- Closed: t_b18779b5 (MotionController), t_53ff09e1 (pathfinding stuck-loop), t_3dee4fae (BodyMutex impl)
- t_18006055 (Reactive Runner Phase 1 epic) — code done, needs e2e validation

### Commits on feat/motion-refactor
- Bounding box guard + patch-package
- canSprintJump disabled
- Faster stuck detection timings
- Recovery FSM stripped
- Stuck restart through goto/follow with centering

---

## Session State — 2026-05-29 (Pathfinder Sprint + Step-Up Fix)

### Problem
With `allowSprinting=true`, the bot got stuck on 1-block step-ups (`direction=step`). Walking worked; sprinting failed. The pathfinder planned sprint-jump step-ups, but execution collided with the block face because sprint speed carried the bot into collision before vertical lift cleared the ledge.

### Root Cause (forum consensus: Claude, Codex, Gemini, Grok)
1. **Phantom node advancement:** `getReached` used `Math.abs(delta.y) < 1`, which is true mid-jump (e.g. delta.y = 0.58 on tick 1). The pathfinder advanced `path[0]` while the bot was still in the air.
2. **Sprint-jump timing:** `canSprintJump` returns true geometrically, but at sprint speed the bot crosses the optimal launch window (~0.7–1.2 b from edge) in 2 ticks. Collision zeros horizontal velocity during rise, so the bot crawls forward and lands short.

### Final Fix (committed)
**Strategy:** Disable `canSprintJump` entirely. Sprint only on flat straight lines.

**File:** `agents/bot/node_modules/mineflayer-pathfinder/index.js`
- `monitorMovement` sprint-jump branch: disabled with `false && ...`
- Any jump falls through to `canWalkJump` (walk+jump, no sprint)

**File:** `agents/bot/node_modules/mineflayer-pathfinder/lib/physics.js`
- `getReached`: kept original value `< 1` (reverted from `< 0.25`)

**File:** `agents/bot/server.js`
- `allowSprinting = true` — sprint on flat straight lines, walk on jumps

**What didn't work:**
- `getReached < 0.25` alone → still stuck on steps
- `getReached < 0.25` + sprint guard `(path[0].y - p.y) <= 0.5` → worked for forward trip but failed on return; sprint guard only prevents sprint on step-ups, not barriers/jumps at same Y level
- Disabling `canSprintJump` alone was insufficient with original getReached when bot started near obstacles

**What works:**
- Kill `canSprintJump` entirely + `getReached` at original `< 1` + `allowSprinting=true`
- Full round trip (2→1→2→3) passes, zero stuck events
- Bot sprints on flats, walks on all jumps

---

## Session State — 2026-05-28 (Pathfinder Bounding Box Fix)

### Problem
The bot repeatedly got stuck against 1×1 columns and fences because `mineflayer-pathfinder`'s A* treated the bot as a point when validating diagonal moves. It allowed diagonal paths as long as **one** of the two cardinal adjacent blocks was clear, ignoring that the bot's 0.6×0.6 bounding box clips the corner of the solid block during the diagonal traversal.

### Fix (committed on `feat/motion-refactor`)
**File:** `agents/bot/node_modules/mineflayer-pathfinder/lib/movements.js` (persisted via `patch-package`)
- In `getMoveDiagonal`, added a bounding-box guard after computing `blockC1` and `blockC2`:
  ```js
  if (blockC1.physical || blockC2.physical) return
  ```
- This rejects any diagonal move where either cardinal neighbor is a solid block (`physical === true`), forcing the pathfinder to route around corners via cardinal steps only.

**Supporting changes:**
- Added `patch-package` + `postinstall` script in `agents/bot/package.json` so the patch survives `npm install`.
- Added `_recoveryEnabled = false` flag in `MotionController` to disable the recovery FSM during pathfinder debugging (recovery code preserved, not deleted).
- Extended `path_update` logging in `server.js` to emit full path node sequences for diagnostics.

### Test Results
- Round-trip navigation between 3 targets with 1-block columns and 1-block gaps works reliably.
- Path lengths increased (more nodes) but zero stuck states observed.
- Recovery FSM remains disabled until we decide the pathfinder is robust enough to re-enable it.

### Next Question
Does this fix also resolve the `allowSprinting = false` requirement? With correct corner avoidance, the bot may no longer bump into block edges when sprinting, so we should test re-enabling `allowSprinting`.

---

## Session State — 2026-05-25 (MotionController Refactor)

### Branch: feat/motion-refactor (base: b09a1e7 on feat/reactive-runner-phase1)

### Architecture after refactor

**MotionController** — single owner of all pathfinding/movement state:
- MotionSession replaces `_active`/`_recovering`/`_targetGoal` booleans
- SESSION_STATE enum: idle → navigating → stuck_detected → recovery_atomic → replanning → complete/cancelled/failed
- Goal descriptors preserve block/near/follow types; GoalNear no longer degrades to GoalBlock
- goto()/gotoNear() use manual setGoal + `goal_reached` listener (not pathfinder.goto which rejected on goal change)
- `_pendingGotoCleanup` hook resolves promises immediately on external cancel (no 15s hang)
- Fast-stuck detection uses session state (`s.state`) instead of booleans
- Follow sessions skip recovery (cannot resume GoalFollow without live entity ref)

**Recovery FSM** — deterministic, atomic maneuvers per PLAN-motion-refactor.md:
- Step recovery: `_doStepRecoveryFSM` — pause → sneak back 260ms → deliberate Y rotation (PI/3) → jump forward 600ms → measure → replan original goal
- Lateral recovery: `_doLateralRecoveryFSM` — pause → compute obstacle world normal → rotate away (±0.5 rad) → measure in new frame → strafe away → verify → replan or fallback to step
- Mine recovery: `_doMineRecoveryFSM` — pause → mine block at face → fallback to step
- `_classifyBlocked`: Tier 0 step check (feet solid + head air) BEFORE body-level Tier 1
- Generation guards (`_isSessionValid`) after EVERY await sleep/look in all FSMs
- `stop()` yields 100ms when `_activeRecovery` is true

**BodyMutex** → routes through MotionController:
- `_cancelCurrent()` calls `motion.requestMutexCancel()` instead of raw `pathfinder.stop()`
- `emergencyStop()` calls `motion.requestEmergencyStop()`
- Cancel defers during RECOVERY_ATOMIC; emergency stop bypasses
- `cancelRequested` consumed in `_handleStuck` finally

**Combat system:**
- `attack()` auto-equips best weapon via `equipBestWeapon()` from combat-data.js
- `flee()` uses micro-steps: backstep (<3m) | strafe (3-5m) | clear (>5m) — replaces gotoNear(8 blocks)
- `_has_weapon()` in runner checks inventory (not just held item)
- Fallback: when target not in hostile list → nearest non-player entity (defense against unknown attackers)
- `fight()` auto-equips best weapon before sustained combat loop

**`agents/bot/lib/combat-data.js`** — SINGLE SOURCE OF TRUTH:
- `HOSTILE_NAMES`: 37 hostile entities (includes vindicator, evoker, pillager, etc.)
- `WEAPONS`: swords + axes in damage order + trident/mace
- `BANNED_FOOD`: rotten_flesh, pufferfish, chorus_fruit, poisonous_potato, spider_eye
- `equipBestWeapon(bot)`, `isHostileName(name)`, `hasWeaponInInventory(bot)` helpers
- All server.js code imports from here; zero ad-hoc lists remain

**Auto-eat:**
- `minHunger: 18` (eat when below regen threshold to keep saturation high for health recovery)
- `minHealth: 19` (prioritize high-saturation food when any health missing)
- `returnToLastItem: true` (re-equip weapon after eating)
- Banned foods from `BANNED_FOOD`

### Files

| File | Changes |
|------|---------|
| `agents/bot/lib/motion-controller.js` | Major: MotionSession, Recovery FSM, BodyMutex routing, N1 cleanup hook |
| `agents/bot/lib/combat-data.js` | NEW: centralized hostile/weapon/armor/food lists |
| `agents/bot/lib/mutex.js` | Light: routes through MotionController |
| `agents/bot/server.js` | attack auto-equip, micro-step flee, fallback defense, auto-eat tuning, combat-data imports |
| `agents/runner/thread.py` | _has_weapon checks inventory, flee_step counter, _food_cache |
| `agents/bot/tests/test-motion-controller.js` | 23 tests covering all phases + B1-B3 + follow skip + stale guards + cancel consume |
| `PLAN-motion-refactor.md` | Implementation plan document |

### Commits on feat/motion-refactor (from b09a1e7)
```
1ca0e81 fix: attack/flee fallback to nearest non-player entity
10b1687 fix: N1 — goto promise resolves immediately on external cancel
c9ed9af refactor: centralize hostile/weapon/armor/food lists in combat-data.js
ec11df0 feat: micro-step reactive flee — backstep/stafe/clear per tick
9da40eb fix: auto-eat minHunger=18 minHealth=19
91f3621 fix: auto-eat base config
c446a41 fix: auto-equip best weapon in attack(), check inventory not holding
2951e70 fix: B1+B2+B3 — atomic recovery, manual goto with listener, stale guards, cancel consumed
928f2d3 docs: motion-controller refactor implementation plan
634d3fe Phase 3: BodyMutex routes through MotionController
bcd9388 Phase 2: Recovery FSM — deterministic step/lateral/mine recovery
13050fb Phase 1: MotionSession + goal descriptor — single session owner
139cf14 Phase 0: scaffolding — dispose, control helpers, try/finally, tests
```

### PENDING
- Live verification: step/lateral stuck recovery with real terrain
- Claude re-review after N1 fix (found NO-GO then, needs re-check)
- Full ACTION_REGISTRY integration (currently light: only tag==='atomic' check)
- Robot tests: test-flee-microstep.js untracked (Grok created, needs review + commit)

## Architecture — Session & Controller Model (2026-05-25)

### Controller Lease (bot server)
- Bot server hosts `POST/GET /controller/lease` with `{owner, ttl}` (TTL-based)
- `owner: "human:cli"|"human:telegram"|"autonomous"`
- Agent loop claims `"autonomous"` when no human lease active (every 30s)
- Gateway reads lease: if `"human:*"` active → skip agent turns (chat + heartbeats)

### Session Separation (DO NOT CROSS)
- **CLI session**: direct AIAgent connection, bypasses gateway entirely
- **Gateway daemoncraft session**: separate, for autonomous operation
- **They do NOT inject into each other**. Gateway CANNOT forward to CLI.
- Bridge between them: **event queue** + **context stream** files

### Event Queue Bridge (`compaii-events.jsonl`)
- Gateway writes skipped chat messages here when CLI controls the bot
- Agent loop reads events each tick, includes them in context stream
- CLI reads stream to see what happened in Minecraft chat

### Context Stream (`compaii-stream.json`)
- Agent loop writes enriched state every idle heartbeat tick
- CLI reads for bot state (health, position, nearby, chat, actions)
- Atomic write (tmp → rename)

### /combat Endpoint (enriched)
- Hostile positions (not just distance), actionHistory with timestamps, runner mutex state
- Single-call agent feedback loop

### Key Rules
- Gateway NEVER injects into CLI session
- CLI reads bot state via `/combat`, `/status`, or stream file
- Controller Lease is the single arbiter of who spawns agent turns
- `runner/thread.py` get_status() tracks reflex history (not used for session arbitration)


## CRITICAL: Docker Mount Structure (2026-05-25)

The Docker container `daemoncraft-minecraft` mounts:
- `~/Projects/DaemonCraft/server/data/` → `/data/` (rw) — THIS is where server.properties, world/, purpur.yml etc actually live
- `~/Projects/DaemonCraft/server/server.properties` is NOT the live file — it's a repo copy
- To change server config: edit `server/data/server.properties`
- To change gamerules: edit `server/data/server.properties` AND set at runtime via bot command
- To check runtime: `docker exec daemoncraft-minecraft cat /data/server.properties`

Bot config lives at: `agents/bot/config-compaii.json` (separate from Minecraft server config)

## Session State — 2026-05-25 (night session, ~4h)

### MotionController Recovery System (IN PROGRESS)
- **Fast stuck detection**: 200ms interval, triggers recovery if no movement >0.3m in 200ms
- **Direction classification**: 5 directions (forward, left, right, forward-left, forward-right) × 4 heights (0.4, 0.9, 1.4, 1.9)
- **path_reset simplified**: only logs, no longer triggers recovery (fast stuck is sole recovery trigger)
- **Recovery types**:
  - Forward block → mine recovery (dig block ahead)
  - Lateral/forward-diagonal → lateral recovery (crouch backstep + turn + crouch strafe away from obstacle)
  - Step (block at y+1) → step recovery (crouch backstep + jump forward)
  - Unknown → step recovery (fallback)
- **Race condition fixed**: goto/gotoNear don't reset _active during recovery

### Runner Combat System (IN PROGRESS)
- Entity detection: 3m range + line-of-sight check (midpoint block must be air)
- Anti-flee-chain: after recent flee + hostile >6m → attack; 1 failed flee → attack
- Weapon cache: 3s TTL to avoid /status timeout during combat
- TP cleanup: clears runnerEventBuffer + bodyMutex.emergencyStop on teleport

### Controller Mode
- Lab mode HARDCODED in server.js (config loading from unifiedConfig not working yet)
- Gateway skips turns when mode=lab (checks /controller/mode endpoint)
- Chat messages written to event queue (compaii-events.jsonl) as bridge to CLI
- Mode changes via: POST /controller/mode {"mode":"lab"|"autonomous"}

### PENDING / KNOWN ISSUES
- **keep_inventory gamerule**: runtime verified/set with `docker exec daemoncraft-minecraft rcon-cli "gamerule keep_inventory true"`. Old `keepInventory=true` in `server/data/server.properties` is camelCase and not sufficient evidence; use snake_case command as source of truth.
- **controllerMode persistence**: not loading from config-compaii.json (unifiedConfig ordering issue). Hardcoded for now.
- **Flee direction**: needs iterative goto like attack (re-evaluate each tick instead of single gotoNear)
- **Lateral recovery effectiveness**: being tested with spiders/drowned
- **inventory drops on death**: suspected keepInventory not applied at runtime

### Key Files Modified
- agents/bot/lib/motion-controller.js: full recovery system rewrite
- agents/bot/server.js: controllerMode hardcoded, TP cleanup, entity detection range, auto-equip removed
- agents/runner/thread.py: flee threshold, anti-flee-chain, reflex tracking
- agents/agent_loop.py: _build_body_session, wake_body rename, controller mode
- gateway/platforms/daemoncraft.py (hermes-agent): controller mode check, event queue bridge

### Docker Mount Structure (CRITICAL — DO NOT FORGET)
- Container mounts: ~/Projects/DaemonCraft/server/data/ → /data/ (rw)
- server.properties lives at: server/data/server.properties (NOT server/server.properties)
- Container restart: docker restart daemoncraft-minecraft
- RCON: docker exec daemoncraft-minecraft rcon-cli "<command>"
- Current Purpur gamerule names are snake_case: use `gamerule keep_inventory true`, NOT old camelCase `keepInventory`. Persist startup runtime rules in `server/data/purpur.yml` `settings.startup-commands`; current persisted commands: `gamerule keep_inventory true` and `difficulty easy`.

## Current Snapshot — 2026-05-16 (lab/default gateway/Gemma-Andy)

### Decision Architecture — What to use when (from benchmark session)

Based on 45-iteration benchmark today with lab-v1 experiments against our world:

| Task type | Best approach | Why |
|-----------|--------------|-----|
| **Navigation** (come, follow, goto) | `embodied_plan` + narrow `allowed_tools` | "ven aca" → goto works. verbose+constraints → follow surgical. Without constraints, model adds clutter (mine_blocks, craft_item). |
| **Building** (place, fill) | `embodied_plan` AFTER `setup` clears floor | dead_bush/leaf_litter blocks placement. `clear_area` in experiment setup fixes it. `hermes_style` English intents cleanest. Explicit inventory mention CONFUSES. |
| **Recovery** (stuck, missing_material) | `embodied_plan` + `previous_error` | stuck→goto recovery works 100%. `recovery_naive_retry` mitigation fires correctly. Recovery generalization solid (17/18 on 008/009). |
| **Fallback** (Andy unavailable/confused) | `mc_*` direct tools (Path 0) | When Gemma emits clutter or times out, use direct mc_move, mc_build, mc_mine. |
| **Verification** (before/after) | `mc_bit(format='full')` small volume | 4×4×4 full grid for exact diff. mBit context now injected into world_state. |
| **Spatial awareness** | `mc_bit(format='binary')` before navigation | Checks walkability. Use `surface` before building. `rows` for escape direction. |

**Key patterns:**
- Spanish terse intents ("ven aca", "seguime NicoElViejoGamer") work but produce clutter with wide tools
- Narrow `allowed_tools` = clean single-purpose plans; wide = creative but noisy
- `hermes_style` English intents most reliable
- Explicit inventory mentions ("tenés terracotta(60)") confuse Gemma-Andy — model checks inventory instead of acting
- Recovery with `previous_error` is solid, especially `stuck` → replan
- `place_block` now validates materialization post-placement (commit 249a024)
- Setup phase with `clear_area` + `give_items` is essential for building experiments

**Player:** NicoElViejoGamer (full username, not "Nico")

## Session Summary — 2026-05-16 (CompAII deepseek-v4-pro)

### Bugs Fixed (5 commits in feat/canonical-loop)

| Bug | Commit | Root cause | Fix |
|-----|--------|-----------|-----|
| Pathfinder race condition | `3819b10` | Watchdog canceled in-flight goals | `actionInProgress` guard |
| Dispatcher no tool filter | `3819b10` | Gemma generated tools outside allowlist | `allowedTools` enforcement in dispatch() |
| move_away broken | `3819b10` | `flee()` couldn't parse coordinate strings | Parse "x,y,z" as from target |
| mine_block self-burial | `60172b0` + `e168e97` | Bot mines at same Y level, falls in | (a) top-first Y-descending sort (b) filter blocks at/below feet (c) pre-dig safety check |
| equip_item policy failure | `3819b10` | craft_item outside allowed set | Dispatcher enforcement |

### mBit Perception System — IMPLEMENTED

| Component | File | Status |
|-----------|------|--------|
| Block→char dictionary | `agents/bot/lib/mbit.js` | ✅ 80+ mappings, 5 formats |
| GET /blocks endpoint | `agents/bot/server.js` | ✅ Miki + CompAII, ~1ms/volume |
| Format encoding in endpoint | `agents/bot/server.js` | ✅ `?format=binary\|columns\|rows\|surface\|full` |
| Hermes tool | `tools/mc_bit_tool.py` (hermes-agent feat/daemoncraft) | ✅ registered |
| 2D visualizer | `agents/bot/mbit-viz.html` → `/mbit` | ✅ grid + Y-slider + chars/blocks |
| 3D visualizer | `agents/bot/mbit-viz3d.html` → `/mbit3d` | ✅ Three.js local + chars/blocks/wireframe |
| WebSocket real-time | server.js blockUpdate → WS broadcast | ✅ no polling |
| Delta detection | lastText cache in both viz | ✅ skip re-render on no change |
| Follow-bot default | both viz | ✅ checked by default |

**Visualizers:** `http://localhost:3003/mbit` (2D grid) and `http://localhost:3003/mbit3d` (3D wireframe)

### Architecture Docs Ingested (Mariano's private repo)

All in `~/wiki/projects/DaemonCraft/architecture/`:
- mariano-CLAUDE.md (architecture split: Hermes/Gemma-Andy/Guardian/Mineflayer)
- mariano-integration-guide.md (Path B canonical, 68 tools schema)
- mariano-hermes_policy.py (5-layer policy reference)
- mariano-PLAN.md (DaemonCraft master plan)
- mariano-handoff.md (debug sprint 2026-05-15)
- mariano-hackathon-plan.md
- mariano-integration-options.md
- mariano-ollama-usage.md
- mariano-pitch.md
- mariano-tools-pending.md

### Architecture Diagram

`~/Projects/DaemonCraft/architecture-diagram.html` — Full SVG of HermesCraft stack (live in browser)

### Tier-1 Experiment Status

8/8 variant types functional with policy_mode="auto". Matches Mariano/Fede pattern:
- Embodied: follow, goto, equip, mine_block, mark_and_return ✅
- Upstream: ambiguous, out_of_scope ✅
- Gap: mine_block in mesa biome requires walking to terrain edge (terracotta below surface)

## mBit Integration Plan

**Next Kanban card:** mBit integration into CompAII decision pattern.
See card for full spec. Three layers:
1. Pre-action verification (mc_bit before spatial tools)
2. Inject into Gemma-Andy world_state (format chosen by policy layer)
3. Verify loop (perceive→act→perceive→diff)

## mBit Perception System

**Status:** Library + endpoint + Hermes tool implemented. Pending: integration into decision loop.

- `agents/bot/lib/mbit.js` — 80+ block→char mappings, 5 format encoders (binary/columns/rows/surface/full)
- `GET /blocks?format=binary|columns|rows|surface|full` — bot endpoint, tested ~1ms for small volumes
- `mc_bit` Hermes tool — queries bot and returns text-native spatial representation
- Wiki: `~/wiki/projects/DaemonCraft/mbit/` (index, architecture diagram, Grok research)
- Kanban: `t_1a4a30b8` (review), `t_dc1f53fd` (endpoint), `t_c8090e58` (edge cases), `t_d8ff3766` (testing)
- Known gaps: semantic/region abstraction, format selection policy (Geppetto review)
- Verify loop: perceive→act→perceive→diff (not yet implemented)

**Runtime ground truth:**
- Active repo branch: `feat/canonical-loop`.
- Active cast: `lab` via `~/.config/daemoncraft/cast.conf`.
- `daemoncraft.service` is the Minecraft server; `daemoncraft-cast.service` manages the single local CompAII bot on `http://localhost:3003`.
- CompAII is a `type: local` agent using existing `HERMES_HOME=/home/nicolas/.hermes`; no isolated `~/agents/compaii` workspace.
- The default Hermes gateway is now the canonical gateway for this lab loop: `hermes-gateway.service` runs from `~/.hermes/hermes-agent`, connects to Telegram and to DaemonCraft (`platforms.daemoncraft.extra.bot_api_url=http://localhost:3003`, `bot_username=CompAII`).
- `hermes-gateway@steve.service` and `hermes-gateway@gandy.service` are stopped and disabled while `CAST=lab` is active; those services target stale ports `:3001`/`:3002` and create reconnect noise.
- `embodied-service.service` runs Path B on `:7790` with `BOT_API_URL=http://localhost:3003`, `OLLAMA_URL=http://10.10.20.1:11434`, and model `gemma-andy:e4b-v2-2-3-q8_0`.

**Current session objective:** use CompAII's own Minecraft bot as the controlled laboratory body to understand the full loop end-to-end with maximum agency:
`Telegram/default Hermes gateway -> DaemonCraft platform adapter -> CompAII world session -> mc_* tools / embodied_plan -> bot/server.js -> Minecraft`.

**Architecture rule:** no blind autonomous split-brain. Path 0 (Hermes direct `mc_*` tools) remains the reliable fallback/control path. Path B (Hermes delegates to Gemma-Andy through `embodied_plan` / embodied-service) is introduced only for measured, policy-filtered body primitives.

**Gemma-Andy source state considered for this session:**
- Mariano repo: `https://github.com/Mar-IA-no/deamoncraft-gemma4-andy`, default branch `main`, latest observed commit `ecc1fd57` (`Polish public contest documentation`, pushed 2026-05-15T23:48:35Z).
- The repo documents `gemma-andy:e4b-v2-2-3-q8_0` as a local/Ollama Gemma 4 E4B-it LoRA body orchestrator for Mineflayer.
- Reference policy: 5 Hermes-side layers before invoking Gemma-Andy — scope filter, ambiguity detection, surface normalization, multi-step decomposition, and narrow `allowed_tools` per intent category.
- Contest/debug result framing: the system solved the Tier-1 critical subset 45/45: 35 embodied executions by Gemma-Andy, 10 handled upstream by Hermes without invoking Gemma. Treat this as roughly “80% Gemma after policy + 20% Hermes upstream handling,” not as raw Gemma reliability.
- Critical integration lesson from Mariano/Fede: the loop breaks when Hermes sends raw Spanish/colloquial/vague intents or wide tool palettes to Gemma. Gemma-Andy must receive compact English imperative body commands, canonical Minecraft names preserved, inline conditions/fallbacks, 17-field-ish world_state, and narrow per-category `allowed_tools`.
- Local gap as of this snapshot: `embodied-service` is mostly aligned (user-only Ollama call, schema filtering, fail-fast dispatch), but the live Hermes `embodied_plan` tool does not yet implement Mariano’s upstream policy wrapper. Import target: policy wrapper before POST `/intent`; heartbeat scan should use perception-only tools or deterministic state injection.
- Policy import audit note: `/home/nicolas/wiki/projects/DaemonCraft/notes/gemma-andy-policy-import-audit-2026-05-16.md`.
- Do not oversell unresolved areas: schema v2 coverage, recovery with `previous_error`, `pickup_item`/auto-pickup, `pillar_up`/place timing, food-state edge cases, semantic runner checks, and future v2.2.4 dataset rebalance.

**Local documents ingested for this session:**
- `/home/nicolas/Downloads/GOOGLE_SUBMISSION_PACK_kaggle-gallery.md` — Kaggle submission structure, media gallery, and narrative/technical architecture framing.
- `/home/nicolas/Downloads/HERMES_GEMMA_DEBUG_HANDOFF_2026-05-15.md` — sprint handoff: why Hermes remains narrative/policy head while Gemma-Andy absorbs only measured embodied primitives.

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

### CompAII Bot Service (Laboratory Mode)

CompAII operates in **laboratory mode**: the bot is managed by `daemoncraft-cast.service` (`CAST=lab`) and the default Hermes gateway (`hermes-gateway.service`) is wired to its Bot API on `:3003`. CLI/manual `mc_*` control remains available, but the active lab loop now uses the default gateway so Telegram, DaemonCraft WS heartbeats, and direct tool control exercise the same body.

| Service | Purpose | Port | Status |
|---|---|---|---|
| `daemoncraft.service` | Minecraft server | 25565 | Active |
| `daemoncraft-cast.service` | Lab cast launcher | bot :3003 | Active (`CAST=lab`) |
| `hermes-gateway.service` | Default Hermes gateway (Telegram + DaemonCraft) | WS to :3003 | Active |
| `embodied-service.service` | Gemma-Andy Path B bridge | 7790 -> bot :3003 | Active |
| `hermes-gateway@steve/gandy.service` | Old per-agent gateways | :3001/:3002 | Stopped + disabled in lab |

**Commands:**
```bash
systemctl --user status daemoncraft-cast.service
systemctl --user restart daemoncraft-cast.service
journalctl --user -u daemoncraft-cast.service -f
```

**Config:** `~/Projects/DaemonCraft/agents/casts/lab.yaml`
**API:** `http://localhost:3003`
**Username:** `CompAII`

**Env vars in `~/.hermes/.env`:**
```
MC_API_URL=http://localhost:3003
EMBODIED_SERVICE_URL=http://localhost:7790
MC_USERNAME=CompAII
```

### Cast `lab` (Laboratory Mode)

The active cast is `lab` (configured in `~/.config/daemoncraft/cast.conf`). It runs a single local agent:

```yaml
agents:
  - name: CompAII
    type: local
    hermes_home: ~/.hermes
    port: 3003
    agent_loop: true   # Enabled for debugging
```

**Processes managed by the cast:**
| Process | Description |
|---|---|
| `node server.js` | Bot (Mineflayer API on :3003) |
| `python agent_loop.py` | Autonomous heartbeat loop (interval=7s) |

The `agent_loop` is **optional** for local agents (`agent_loop: false` by default). Set to `true` only when debugging autonomous behavior.

**Previous standalone bot service** (`daemoncraft-bot-compaii.service`) has been disabled — the cast now manages both bot and agent_loop.

## Agent Types in Casts: `cast` vs `local`

The cast system supports two agent types:

| Type | Use case | Workspace | Gateway | Bot | Agent loop |
|---|---|---|---|---|---|
| `cast` (default) | Isolated agents with their own config, memory, and autonomy | `~/agents/<name>/` | `hermes-gateway@<name>.service` | Yes | `agent_loop.py` |
| `local` | Agents that already exist as Hermes profiles (e.g. `compaii`, `riqui`) | None — uses existing `HERMES_HOME` | None — uses existing gateway | Yes | None — controlled by user |

### `type: local` agent

For agents that already live in the system as default Hermes profiles. The cast only:
1. Configures `MC_API_URL`, `MC_USERNAME`, `EMBODIED_SERVICE_URL` in the profile's `.env`
2. Starts the bot server (`node server.js`)
3. Does NOT create workspace, gateway, or agent_loop

**Example cast config:**
```yaml
agents:
  - name: CompAII
    type: local
    hermes_home: ~/.hermes
    port: 3003
    bot_config:
      minecraft:
        host: localhost
        port: 25565
        auth: offline
```

**Implementation:** `configure_local_agent_env()` in `agents/workspace.py`

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

## Autonomía Corporal — Autonomous Plan Execution

**Implemented 2026-05-10.** Two new modules in `agents/`:

### `plan_schema.py` — Data model
- `PlanState` enum: IDLE → EXECUTING → BLOCKED → ESCALATED → REPLANNING → COMPLETED
- `DangerLevel` enum with explicit taxonomy (per GePeTo review)
- `VerifyType` enum: inventory_has, area_clear, position_reached, block_placed, entity_nearby
- `Step` dataclass: id, intent, verify, max_retries, retries, backoff_base
- `Plan` dataclass: goal, steps, current_step, state, timeouts
- Serde: `load_plan()` / `save_plan()` → `workspace/plan.json` (atomic write via temp file)

### `autonomous_loop.py` — Finite-state controller
- Reads plan from `workspace/plan.json`, executes steps via `POST /intent` to embodied service
- Machine-checkable verification against bot server API
- Exponential backoff on retry (2^retries seconds), max 3 retries
- Confidence gate: if `operational_risk` high/critical → escalate immediately
- Structured JSON logging for every decision
- Idle heartbeat: world_state injection via Gemma every ~30s when no plan active

### Integration
- `daemoncraft.py`: launches `agent_loop.py --interval 7` (single mode, plan-driven)
- `workspace.py`: creates `workspace/` subdir, writes `EMBODIED_SERVICE_URL` and `PLAN_FILE` to `.env`
- `cmd_daemon`: assumes workspace already bootstrapped by `cmd_start`; only restarts crashed processes
- `cmd_update`: backs up `plan.json` from `~/agents/<name>/` before wipe, restores after `cmd_start`

**⚠️ Template update rule:** Every code change that affects the agent runtime (env vars, directory structure, loop behavior, SOUL composition) must be verified against ALL paths that create or update agent workspaces:
  1. `cmd_start` — bootstrap_agent_workspace + SOUL composition → `~/agents/<name>/`
  2. `cmd_update` — wipe + cmd_start + restore plan.json
  3. `cmd_daemon` — crash restart (assumes workspace exists)
  4. `workspace.py` — bootstrap_agent_workspace (creates .env, config.yaml, venv, workspace/)
  If a change touches one path, verify the others still produce a working agent. Never leave dead code paths that reference old directory structures (~/.hermes/profiles/).

### Wake-up triggers (Steve escalation)
- `plan_complete` — all steps done
- `step_failed` — step exhausted max_retries
- `danger_critical` — irreversible_action, security_risk, plan_corruption
- `plan_timeout` — no advance in 5 min


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

### Bot API Inconsistencies (Known Bugs)

| Endpoint | Field Missing | Workaround |
|----------|--------------|------------|
| `/nearby` | `entities[].name` for players | Cross-reference with `/status` (`nearbyPlayers[].name`) or `/scene` (`visible_entities[].type`) |

**Verified:** 2026-05-15 — `/nearby` returns `{"type": "player", "kind": "player", ...}` but omits `name`. `/status` and `/scene` include the username. This forces tools to fall back to secondary endpoints for player identification.

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

### Plugin List (confirmed loaded — 15 total, post-PR merge)
- `multiverse-core.jar` (4.3.14) — world management
- `worldedit-bukkit-7.4.2.jar` — WorldEdit
- `citizens2.jar` + `Citizens/` — NPC framework
- `denizen.jar` + `Denizen/` — scripting
- `geyser-spigot.jar` + `Geyser-Spigot/` — Bedrock bridge
- `floodgate-spigot.jar` + `floodgate/` — auth bridge
- `LibsDisguises.jar` + `LibsDisguises/` — entity disguises
- `packetevents-spigot-2.12.1.jar` — packet API
- `ChatFilter.jar` + `ChatFilter/` — chat moderation
- `CoreProtect.jar` + `CoreProtect/` — block logging / rollback
- `DecentHolograms.jar` + `DecentHolograms/` — floating text / holograms
- `LuckPerms.jar` + `LuckPerms/` — permissions
- `Plan.jar` + `Plan/` — server analytics / metrics web UI
- `SkinsRestorer.jar` + `SkinsRestorer/` — custom skins
- `TAB.jar` + `TAB/` — tab list / scoreboard / nametags
- *(PlaceholderAPI is also installed as a dependency for TAB/SkinsRestorer)*

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
- **NicoElViejoGamer** is the human player. Use this exact username for mc_move follow, mc_chat whisper, and any player-targeted commands. (Not "Nico" — the server entity uses the full username.)

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

## Completed This Session (2026-05-03)

- **PR #2 (Geyser/Bedrock)**: Merged. Geyser-Spigot plugin + Geyser config + `allow-non-mojang-profiles` for offline-mode crossplay.
- **PR #3 (Server Setup)**: Merged. 8 new plugins: ChatFilter, CoreProtect, DecentHolograms, LuckPerms, Plan, SkinsRestorer, TAB, PlaceholderAPI. Docker compose reorganized with `plugins` profile.
- **PR #4 (DC-131 — Safety)**: Merged. ChatFilter config (no curse words), `ENFORCE_WHITELIST: "false"` (disabled per user request for local testing). Conflicts resolved in docker-compose.yml.
- **PR #5 (DC-132 — Observability)**: Merged. Plan plugin + agent metrics JSONL logging. Conflicts resolved in docker-compose.yml.
- **PR #6 (Client Packs)**: Merged. `docs/` no longer ignored; client packs documentation preserved. Conflicts resolved in `.gitignore`.
- **Post-merge fixes**: Removed duplicate `geyser-spigot.jar` from volume; fixed `server/geyser/cache/` permissions (chown 1000:1000); set `DIFFICULTY: peaceful` in docker-compose.yml.
- **Server recreation**: Container recreated with `--force-recreate`. All 15 plugins confirmed loaded and healthy.
- **kanban.db corruption**: Gateway failed with "file is not a database". Root cause: corrupted SQLite header. Fixed by backing up and recreating `kanban.db`, then restarting `hermes-gateway.service`.
- **Steve + NicoElViejoGamer**: Both online on live server after merge.

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
- **Kanban**: Task tracking via Hermes Kanban (`hermes kanban --board daemoncraft`). Dispatcher OFF — manual mode only.
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

## Kanban Task Tracking (migrated from Lattice 2026-05-08)

Board: `hermes kanban --board daemoncraft`
Status: manual mode (dispatcher OFF). All tasks in triage — reviewed together via web dashboard.
CLI: `hermes kanban --board daemoncraft list|show|create|comment|complete|...`

Active tasks migrated: 64 (all non-done/non-cancelled from Lattice).
Done tasks (100) not migrated — kept as historical record in .lattice.backup/.

### Epic: DC-124 / DC-126 — Server Setup Overhaul

**Status: IN PROGRESS (2026-05-03).**

The original DC-124 was "Per-profile fairPlayMode" (backlog). The Server Setup Overhaul epic is now tracked as **DC-126** in Kanban ("Epic: Server Setup Overhaul -- Visual & Infra Upgrade", triage).

**What was merged today (PRs #2–#6):**
- PR #2: Geyser/Bedrock crossplay support
- PR #3: Plugin infrastructure (ChatFilter, CoreProtect, DecentHolograms, LuckPerms, Plan, SkinsRestorer, TAB, PlaceholderAPI)
- PR #4: Safety/whitelist (disabled for local testing)
- PR #5: Observability (Plan plugin + metrics JSONL)
- PR #6: Client packs documentation

**Post-merge fix — WorldEdit wand:** Default wand item is `wooden_axe`, which intercepts left-clicks and shows "First position set to..." instead of breaking blocks. Changed to `blaze_rod` in `server/data/plugins/WorldEdit/config.yml`. This change is live in the container volume but NOT in git (server/data/ is .gitignored). Needs persistence mechanism.

**Remaining work (now in Kanban):**
- Image SHA pin + plugin version inventory
- SkinsRestorer + DecentHolograms visual configuration
- `daemoncraft.mrpack` Java client pack
- `daemoncraft.mcpack` Bedrock client pack
- SOUL-rolemaster stage-tools cheatsheet
- Persist plugin configs (WorldEdit wand, etc.) across container recreates

**Deferred per original plan:** multi-server mesh, Velocity proxy, Terraform, pre-built worlds.

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

## Current State (2026-05-03)

**All Fede654 PRs merged (#2–#6).** Server recreated with 15 plugins. Difficulty: peaceful. Whitelist: disabled (for local testing). Container healthy. Geyser/Bedrock crossplay active.

**DC-105 (Unified Social Routing)**: DONE — merged to main (2026-05-02).
**DC-112 (Single-LLM Architecture)**: DONE — gateway owns all cognition, loop is heartbeat injector. Merged to main via `feat/dc-112-daemoncraft-gateway` (2026-05-02).
**DC-124 (Server Setup Overhaul)**: IN PROGRESS — PRs #3, #4, #5, #6 merged. Remaining: DC-125 (stabilize), DC-127 (visual), DC-128 (Java client pack), DC-129 (Bedrock client pack), DC-130 (docs).
**DC-123 (Dashboard/TTS regression)**: BACKLOG — dashboard panels empty after DC-112, TTS relay broken.

**Agent model:** MiniMax-M2.7 (via minimax provider, anthropic_messages api_mode for prompt caching).

**Players online:** Steve (agent), NicoElViejoGamer (human).

**Sandbox mode:** ENDED (2026-05-02). Deploy will be updated via `hermes update` instead of manual file copying.

**Current active cast (2026-05-03):** `companion` (Steve) — agent_loop running manually on port 3001 with MiniMax-M2.7 via `minimax` provider + `anthropic_messages` api_mode. `daemoncraft-cast.service` is stopped for debugging.

## Known Issues / Next Steps

- **Endpoint resolution bug (ACTIVE — 2026-05-03):** Steve's mc_* tools hit stale port 3002 because `minecraft_tools.py` reads `MC_API_URL` from a process-global env var set in `hermes-gateway.service`. The active cast runs on port 3001. Architectural fix needed: derive bot URL per DaemonCraft session, not from global env var.
- **DC-124 remaining tasks**: DC-125 (image SHA pin, rolemaster.yaml model fix, plugin version inventory), DC-127 (SkinsRestorer + DecentHolograms visual config), DC-128 (`daemoncraft.mrpack` Java client pack), DC-129 (`daemoncraft.mcpack` Bedrock client pack), DC-130 (SOUL-rolemaster stage-tools cheatsheet).
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

DaemonCraft Planning Architecture: User prefers persistent, long-term planning over reactive loops. Agents should use a structured Goal & Task system (JSON-based) that persists across turns. Explicit support for a 'Rolemaster' mode (Game Master agent driving narrative/world events). Interest in using Kanban (or a similar dashboard) for real-time visibility and inter-agent coordination of these plans. Strategy roles should be assigned to specific agents for collective orchestration.

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

## CRITICAL: Template Backport Rule (2026-05-10)

**NEVER make runtime-only changes to bots.** Every change — whether to config, SOUL, behavior, tools, env vars — MUST be backported to the source templates:

| Change location | Backport to |
|---|---|
| `~/agents/<name>/hermes-home/config.yaml` | `workspace.py` (config dict) |
| `~/agents/<name>/hermes-home/SOUL.md` | `SOUL-base.md` + `prompts/<template>.md` |
| `~/agents/<name>/hermes-home/.env` | `workspace.py` (env_content f-string) |
| `Hermes config (~/.hermes/config.yaml)` | If DaemonCraft-specific, `workspace.py` |

Without backporting, `daemoncraft.py update companion` wipes and regenerates workspaces from templates, losing ALL runtime changes. This caused repeated regressions on 2026-05-10.

## DaemonCraft Canonical Architecture Notes

### CompAII Role
CompAII = "guardian del loop" (end-to-end monitoring). Expected to proactively watch bots, agent loops, embodied service, plans, detect anomalies, and take corrective action without being asked.

### Gemma-Andy Architecture (from Mariano's INTEGRATION_OPTIONS.md)
- Embodied service must be FAIL-FAST on first tool_call failure
- Consumer (Hermes agent_loop.py) handles retry via previous_error
- Two-tier recovery: Tier 2a = deterministic synthesis (recovery_candidates.py) for place_block SEARCH failures; Tier 2b = previous_error model recovery for cases where Gemma-Andy CAN replan (goto stuck, etc.)

### Terminology Debt
`agent_loop.py` still accepts `--profile` argument, but this is pre-migration terminology from when agents shared a Hermes environment. Each agent now has its own isolated `~/agents/<name>/` workspace. `--profile` should be considered deprecated. If we see it in new tooling or docs, it's a signal of legacy code or missed migration.

### Dispatcher Behavior
compaii tasks in `triage` for safety — ready auto-spawns. Verified 2026-05-08: compaii ready tasks were NOT auto-dispatched (mechanism TBD).

## Multi-Agent Debugging & Ghost Process Hygiene (2026-05-11)

**Problem we keep having:** "No sabemos qué está inicializado, entra basura, nos volvemos locos." Below are the concrete failure patterns found today and their signatures.

### Ghost Agents — Pamplinas
- **Status:** DISABLED (`systemctl --user disable hermes-gateway@pamplinas`). If active again, someone re-enabled it or a deploy recreated the service.
- **Symptom:** Constant storm of MiniMax HTTP 401 errors appearing in Minecraft chat.
- **Root cause:** Pamplinas had an invalid MiniMax API key and retried endlessly.
- **Detection:** `systemctl --user list-units --type=service --state=running | grep hermes-gateway` — verify ONLY expected agents are running.

### Chat Attribution Is Not Identity
- **Symptom:** `<Steve> API failed after 3 retries — Connection error.`
- **Reality:** The error came from **Pamplinas**, not Steve. In DaemonCraft, any bot can inject messages into the shared chat bridge.
- **Rule:** Before blaming the apparent speaker, verify the actual PID via `journalctl --user -u hermes-gateway@<name>`.

### Gateway Session Corruption — "Interrupt recursion depth 3"
- **Symptom:** Agent responds only with `🕊️` and `⚡ Interrupting current task...` repeatedly, never producing real text.
- **Root cause (gAndy):** Session accumulated **8 unhandled API call interrupts**. The gateway cannot recover from stacked interrupts.
- **Fix:** `systemctl --user restart hermes-gateway@<name>` (clean restart, not stop/start — `--replace` flag handles session wipe).
- **Prevention:** If an agent is stuck for >2 minutes, restart before the interrupt queue deepens.

### MiniMax Intermittent Failures
- **Symptom:** `APIConnectionError` or HTTP 401 from MiniMax in Hermes, but `curl` direct to `https://api.minimax.io/anthropic/v1/messages` works.
- **Observation:** Errors are transient. Steve and gAndy keys both have 125 chars and are valid. The 401s may be rate-limit edge cases or auth propagation delays.
- **Debug:** Always test direct curl with the agent's own `.env` before assuming key corruption.

### Gemma-Andy Parse Errors (Embodied Service)
- **Symptom:** `Tool embodied_plan returned error: parse_failed — unparseable Gemma-Andy output (no JSON braces found)`
- **Impact:** Non-blocking — the bot retries or falls back. But it means Ollama/Gemma occasionally returns plain text instead of structured JSON.
- **Note:** The model `gemma-andy:e4b-v2-2-3-q8_0` is the correct one. Oráculo uses `gemma4:e4b-it-q8_0` (inexistent) — that's Sai's domain.

### Quick Health Check Script
```bash
# Verify only expected agents are running
systemctl --user list-units --type=service --state=running | grep hermes-gateway

# Verify bots are connected
curl -s http://localhost:3001/health && curl -s http://localhost:3002/health

# Check for recent errors across all agents (last 5 min)
journalctl --user --since '5 minutes ago' | grep -iE 'error|fail' | grep -vE 'providers.minimax|ollama_call_done|intent_done'
```

## Modpack / Prism Launcher — NVIDIA GPU Routing (2026-05-11)

**Problem:** Prism Launcher (Flatpak) renders Minecraft on Intel UHD Graphics instead of NVIDIA RTX 2060, giving ~5-7 FPS even on low settings.

**Root cause:** Flatpak sandbox does not inherit host PRIME environment variables. Minecraft's OpenGL renderer defaults to the integrated GPU.

**Solution:** Set Flatpak override for Prism Launcher to force NVIDIA PRIME offload:

```bash
flatpak override --user --env=__NV_PRIME_RENDER_OFFLOAD=1 --env=__GLX_VENDOR_LIBRARY_NAME=nvidia --env=__VK_LAYER_NV_optimus=NVIDIA_only org.prismlauncher.PrismLauncher
```

**Verify:**
```bash
flatpak override --user --show org.prismlauncher.PrismLauncher
```
Should show the three env vars under `[Environment]`.

**Check in-game:** Launch instance, look for log line:
```
OpenGL renderer: NVIDIA GeForce RTX 2060/PCIe/SSE2
```

**Notes:**
- `prime-select` is NOT installed on this system — the override is the cleanest path.
- Laptop is always plugged in (no battery), so disabling Intel/Optimus power-saving is fine.
- Do NOT add `[EnvironmentVariables]` to `instance.cfg` — Prism Launcher does not use that format. Flatpak override is the correct layer.
- Shader pack (Complementary Reimagined) should be toggled via `K` in-game once NVIDIA is confirmed working.

---

## Current Session State — 2026-05-14 (feat/canonical-loop)

### What we built today

**DaemonCraft repo (branch `feat/canonical-loop`):**
- `agents/agent_loop.py` — reescrito: heartbeat cada ~28s, guardian loop, hazard detection, wake_steve con cooldown, body_session compuesto, sin planes persistentes, sin daemon_guardian
- `agents/bot/server.js` — agregado `isInWater`, phantom goal timeout (>60s), detector de micro-oscilaciones, body_session en payload
- `agents/embodied-service/lib/world_state.js` — trim campos no canónicos (remembered_places, target_positions, player_health, /marks)
- `agents/embodied-service/profile-templates/daemoncraft-base.SOUL.md` — sincronizado con SOUL deployado

**Hermes-agent repo (branch `feat/daemoncraft`, mergeado a `main`):**
- `gateway/platforms/daemoncraft.py` — idle heartbeats wake up agent cada 90s (throttle 30s → 90s) para dar tiempo de completar acciones

### Problem found & fixed: Steve scan loop

Steve estaba en loop infinito de `scan_nearby` en cada heartbeat. Causa raíz: tenía una **memoria envenenada** en `~/agents/steve/agent-memory/state/DIALOGUE-HANDOFF.daemoncraft.md` y sesiones JSON que decían “esperar mensaje de jugador” — memoria de pruebas anteriores que prevalecía sobre el SOUL.

**Fix aplicado:**
1. Borrado DIALOGUE-HANDOFF.daemoncraft.md y todas las sesiones JSON de Steve
2. Borradas sesiones de SQLite (DELETE FROM sessions/messages WHERE id LIKE '20260514_%')
3. Verificado que HMK library.db no tenía memorias envenenadas
4. SOUL.md actualizado con:
   - “Heartbeat is NOT a loop to stop — it is your sensory system”
   - Prohibición de scan_nearby repetido (máximo 1 cada 3 min)
   - Objetivos idle concretos: oak logs → crafting table → stone pickaxe → shelter → explore
5. Sincronizado a gAndy y al template
6. Gateway reiniciado con sesión limpia (PID 3226200)

### Estado actual de servicios (verificar mañana)

| Servicio | Estado | Notas |
|----------|--------|-------|
| daemoncraft-cast.service | active | Steve + gAndy corriendo |
| hermes-gateway@steve | active (PID 3226200) | Sesión limpia recién reiniciada |
| hermes-gateway@gandy | active | Throttle 90s también aplica |
| embodied-service.service | active | Puerto 7790 |

### Próximo paso a verificar mañana

Steve acaba de empezar sesión limpia con el SOUL nuevo. Necesitamos confirmar que:
1. Recibe heartbeat idle como “context” (no wake_up) hasta que pasen 90s
2. Al recibir wake_up, NO escanea repetidamente
3. Usa el objetivo idle concreto (ej: “Find and mine oak logs”)
4. Completa la acción en lugar de quedarse quieto o escanear

Si sigue con problemas, considerar:
- Agregar `inventory_summary` al body_session (oak_log count, etc.)
- Hacer que agent_loop guarde un `current_goal` persistente entre heartbeats
- Reducir aún más la frecuencia de wake_up si 90s sigue siendo muy agresivo

---

## Current Session State — 2026-05-16 (feat/canonical-loop)

### What we built today

**Canonical bot spawn architecture for local agents:**

Implemented `type: local` support in casts for agents that already exist as Hermes profiles (e.g. CompAII). The cast only configures env vars and starts the bot — no isolated workspace, no new gateway, no agent_loop unless explicitly requested.

**Changes in DaemonCraft repo (branch `feat/canonical-loop`):**

| File | Change |
|---|---|
| `agents/daemoncraft.py` | `type: local` detection in `cmd_start()` and `cmd_daemon()`; new `start_local_agent_loop()` for optional autonomous loop; separate restart logic for local vs cast agents |
| `agents/workspace.py` | New `configure_local_agent_env()` — writes `MC_API_URL`, `EMBODIED_SERVICE_URL`, `MC_USERNAME` to profile's `.env` |
| `agents/casts/lab.yaml` | New cast: single local agent (CompAII) with `agent_loop: true` |
| `MEMORY.md` | This section + updated service table + agent type documentation |

**Commits:**
- `feat: support type: local agents in casts` — workspace.py + daemoncraft.py `cmd_start()` fix
- `feat: lab cast with CompAII as local agent + optional agent_loop` — lab.yaml + start_local_agent_loop() + cmd_daemon() fix + docs

**Service changes:**
- `daemoncraft-bot-compaii.service` — DISABLED (replaced by cast `lab`)
- `daemoncraft-cast.service` — ENABLED, running cast `lab`
- `~/.config/daemoncraft/cast.conf` — `CAST=lab`

**Active processes under daemoncraft-cast.service:**
| Process | PID | Role |
|---|---|---|
| `python3 agents/daemoncraft.py daemon lab` | 392015 | Supervisor |
| `node server.js` | 392017 | Bot API (:3003) |
| `python agent_loop.py --interval 7` | 392073 | Autonomous heartbeat loop |

**Env vars in `~/.hermes/.env`:**
```
MC_API_URL=http://localhost:3003
EMBODIED_SERVICE_URL=http://localhost:7790
MC_USERNAME=CompAII
```

**Key design decisions documented:**
1. `type: local` agents reuse existing HERMES_HOME — no workspace isolation
2. `agent_loop: true` is OPTIONAL for local agents (default false) — used only for debugging autonomous behavior
3. Local agent_loop uses deploy-target venv (`~/.hermes/hermes-agent/venv`) and existing HERMES_HOME
4. Standalone `daemoncraft-bot-*.service` pattern is deprecated in favor of cast-managed bots
5. Two toolset approach: CompAII uses both `minecraft` (direct mc_* tools) and `embodiment` (delegated via gAndy)


## Completed This Session — 2026-05-16

### Policy Import (6 Kanban tasks completed)
- **t_74f2f669** — Created `agents/gemma_policy.py` (349 lines, 5-layer policy: scope, ambiguity, decompose, normalize, narrow tools). 23/23 tests pass. Commit `eb0138c`.
- **t_fd41ddfb** — Wired policy into `tools/embodied_plan_tool.py` in hermes-agent fork (`feat/daemoncraft`). Platform-aware `policy_mode` auto/raw. 16/16 tests. Commit `7aaced594`.
- **t_498cd069** — Fixed gateway heartbeat: narrowed `allowed_tools` to perception-only (5 tools). Reverted risky `_handler` import. Commit `05dee30fe`.
- **t_cf186b4e** — Restructured reference tests into policy-aware layers. 35/37 pass (2 flaky against live model). Commit `10cde45`.
- **t_fe0eaf33** — Schema sync with Mariano repo — identical blob_sha, metadata refreshed. Commit `99d16ff`.
- **t_b2cfbc93** — Verification hooks in `/intent` endpoint: JSONL logging with intent_original, language detection, allowed_tools chain, execution outcome. Commit `62c5c05`.

### World State Completion (17 fields)
- **player_health** — Now read from `bot.players[name].health` via `/nearby`. Bot server line 1343 patched.
- **remembered_places** — New `GET /marks` endpoint on bot server + world_state composer reads it.
- **target_positions** — Added as `{}` to world_state.
- Commit `17fd6de`.

### Chat Fixes
- **Whisper broadcast** — `/msg` whispers now trigger `broadcastDashboard('chat', ...)` via WebSocket (line 566). Gateway was missing whispers. Commit `83dc401`.
- **Authorization** — Added `DAEMONCRAFT_ALLOWED_USERS=<UUID>` to gateway `.env` (NicoElViejoGamer was unauthorized).

### Recovery Reconnection
- **Tier 2a spatial recovery** — Reconnected `recovery_candidates.py` pattern into `embodied_plan_tool.py` raw handler. Spatial errors (target_occupied, no_solid_neighbor, bot_in_target) retry with previous_error payload. Commit `56c61bad4` on hermes-agent `feat/daemoncraft`.

### Kanban Methodology Fix
- Corrected anti-canonical Kanban patterns in global MEMORY.md, hermes-kanban skill, and HMK library.
- `--assignee` auto-promotes to `ready` by design — canonical.
- Parent/child dependency gating — canonical.
- Code tasks use `review-required` block pattern per `kanban-worker` skill.

### Runtime State
- DaemonCraft `feat/canonical-loop`: 1272 lines, 8 new commits this session.
- hermes-agent `feat/daemoncraft`: 2 new commits (wire policy + Tier 2a recovery).
- Deploy target synced. Gateway active and authorized.
- Bot CompAII on :3003, position (538, 118, -376), health 20.

### Next Session Priority
- Test loops: use Mariano/Fede experiment methodology to validate tool access and loop integrity.
- Dashboard unification card: `t_e13dbc90`.

## DaemonCraft SOUL parity notes

- CompAII's DaemonCraft embodiment module lives at `~/.hermes/SOUL_daemoncraft.md`.
- The corresponding lab/local-agent template lives at `agents/SOUL-lab.md` and is referenced by `agents/casts/lab.yaml`.
- Universal bot behavior improvements belong in `agents/SOUL-base.md`; lab/local-only rules belong in `agents/SOUL-lab.md`; CompAII-only identity belongs in `~/.hermes/SOUL_daemoncraft.md`.
- Runtime-only SOUL edits are regressions. Keep runtime/module/template parity when improving embodied behavior.
## SESSION RESTART — 2026-05-26 ~03:40 AM

Debugging runner combat: bot attacks slimes but appears to flee from zombies.

**State:**
- Branch: feat/motion-refactor (DaemonCraft), feat/daemoncraft (hermes-agent)
- Allay disguise removed — can see actual animations now
- agent_loop.py has `[runner-debug]` prints showing runner decisions
- Runner chooses ATTACK for zombies (must_flee=False, threshold=0.9 from ~/.config/daemoncraft/runner.yaml)
- Counter-attack post-flee removed from _handle_critical and _handle_high
- Nuclear TP stop in server.js move handler (pathfinder.setGoal + clearControlStates)
- Timestamps added to bot req/res/body logs
- mc_interoception tool live, runner_state.json writes on every reflex
- /interoception endpoint with summary + detail modes

**What Nico needs to say to resume:**
"Volvamos a debuggear el runner — ataca slimes pero no zombies. Está sin disfraz. Revisá los logs de runner-debug."

**Modified files (uncommitted changes):**
- agents/runner/thread.py (debug prints, counter-attack removal)
- agents/bot/server.js (timestamps, nuclear TP stop)

**Follow-up finding after GPT-5.5 switch (2026-05-26 ~03:48):**
- Concrete root cause found in `attack()` target selection, not `_select_action()`:
  - `target="zombie"` used first substring match, unsorted, so it could attack a far `zombie_villager` instead of the nearest exact zombie.
  - generic `target="hostile"` fallback included non-player items; bot attacked `item` and got kicked with `invalid_entity_attacked`.
- Patched `agents/bot/server.js` to filter attackable living entities only, prefer exact nearest match, then partial nearest, and exclude `item`/`experience_orb`/players.
- Restarted `daemoncraft-cast`, set controller mode back to lab, controlled-spawn verified:
  - slime: runner-debug → ATTACK slime; bot log → `Attacked slime (2–3m away)`.
  - zombie: runner-debug → ATTACK zombie; bot log → `Attacked zombie (2–2.9m away)`.
  - no new `invalid_entity_attacked` kick during verification.

## Session 2026-05-31 — Forum Synthesis, Death Interrupt, Recovery Re-enabled, Full Deploy

### Critical fix — Recovery FSM re-enabled
- `_recoveryEnabled` was set to `false` in commit `d9dba4e` (May 28) for pathfinder debugging and **never re-enabled**.
- This left the bot with ZERO automatic stuck recovery — no step, lateral, or mine recovery.
- Re-enabled in `aa4d731`. Recovery FSM (from `bcd9388` Phase 2): crouch backstep → jump forward (step), strafe away (lateral), mine block (mine).

### Movement fix — Goto promises not cancelled by runner
- `requestMutexCancel()` was resolving goto promises with "Navigation cancelled" every time L2 runner claimed mutex. Since runner attacks constantly, every goto was killed.
- Fix in `c48833c`: runner stops pathfinder + clears controls, but does NOT resolve goto promise. Goto continues after runner releases mutex.

### Death interrupt
- Gateway detects death BEFORE `_classify_heartbeat_event`, sends `/agent/interrupt`, bypasses all guards.
- `[DEATH]` context injected into prompt with respawn position.
- `session_epoch` in `daemoncraft.py` forces fresh session on each gateway restart.

### SOUL rewrites (McCompaii profile)
- **Stuck Protocol**: surface recovery (gAndy → opposite direction → mine → staircase) + underground (tunnel → spiral)
- **NICO IS A SPECTATOR**: injected into heartbeat prompt. Never wait, never follow, never change plans for Nico.
- **Night Protocol**: stripped all mob references. "Combat is not my job."
- **Death**: free teleport, laugh it off, keep exploring.
- **Torch discipline**: 10-13 blocks apart, never cluster.
- **Path building**: flatten earth first, upgrade materials later. Carve INTO terrain, never on top.
- **House respect**: always use doors, never break walls, terracotta houses are home.

### daemoncraft.py changes
- Hostile injection REMOVED from heartbeat prompt
- Health/food/holding/runner stripped from prompt — position only
- Body activity as `[Body]` — info, not problem
- `_inject_embodied_world_state` call REMOVED (was flooding gAndy with scans)
- Session convergence: Minecraft chat injected into world session with internal=True when lab mode
- TTS skip filter: "queued" + "⏳" added
- Voice: es-MX-JorgeNeural

### Hard timeouts on all actions
- dig/collect/place/goto/gotoNear/follow: 30s, fill: 60s, attack: 15s
- ON_ABORT in `_cancelCurrent()`: fire-and-forget (not blocking with await)

### Standard inventory
- `config/mccompaii-standard-inventory.json` + `scripts/restore-mccompaii-inventory.sh`
- Full netherite armor+tools, 3 stacks beef, 3 stacks torches, bed, table, furnace, building materials
- Spawn: terracotta houses (555, 119, -333), world spawn set, bed placed and slept in

### Current known issues
- Pathfinder returns "Navigation cancelled" even when bot moves — misleading message
- McCompaii sometimes ignores tool-calling directive and generates text-only (Kimi k2.6 behavior)
- "Queued for the next turn" messages still appear — turn backlog during long tool calls
- Double sessions may still occur — session_epoch added but needs verification

### Commits today
```
aa4d731 fix: re-enable recovery FSM — was disabled since May 28
c48833c fix: don't cancel goto promises on runner mutex preemption
328d569 fix: fire-and-forget ON_ABORT in _cancelCurrent, add hard timeout to /action
125bac5 feat: forum synthesis — close L4 loop, real cancellation, auto-eat gate, interoception
0b1cc53 fix: filter BANNED_FOOD in eat(), auto-unlock TTS audio on page load
0296517 docs: mutex audit handoff
```

### Architecture docs
- `docs/McCompaii-Autonomous-Behavior.md` — complete L1-L4 reference
- `~/wiki/entities/mccompaii-tts.md` — TTS configuration
- `HANDOFF-mutex-audit.md` — original audit findings
## Session 2026-06-02 — Perception Tools, Narrate Gate, Visual Format

### What we did
1. **mbit visual format (t_891f8020, ✅ done)** — Replaced 5 mbit formats (binary, columns, rows, surface, full) with single 'visual' format. 1166 vanilla Minecraft 1.21.9 blocks mapped with 0 collisions. Mnemonic chars (air=` `, water=`~`, lava=`!`, torch=`†`, lantern=`◊`, redstone_wire=`R`), category chars (door=`◫`, chest=`◰`, furnace=`⊡`, crafting=`⊞`, bed=`⊏`, glass=`▢`), rest to CJK U+4E00+ alphabetically. Server returns 400 Bad Request for any format ≠ 'visual' (no back compat, as Nico requested). Commit 8f5efc1 (DaemonCraft), `agents/bot/lib/block_to_char_1.21.9.{js,json}` (33KB canonical), `lib/build_block_chars.py` (regenerable).

2. **StuckPivotTracker sub-fix 4 (t_436909c6, ✅ implemented, deploy pending)** — bucket_size: 3 (was 5), cooldown: 60s (was 120), obj_key now includes action_class. Path B: position pinned to nearby cells (helper `_cells_within(max_diff=1)`) + all stuck + at least one bad L4 judge. Catches the rotate-action-class thrash that sub-fix 3 missed on 2026-06-01 06:36. Both deploy target and workspace updated. **Restart pending.**

3. **NarrateGateTracker reminder approach (t_0fa2c6dc, ✅ done — will be REPLACED)** — `gateway/platforms/daemoncraft_narrategate.py` detects past-tense narration that contradicts last mc_* tool result. 11/11 unit tests pass. Wired in daemoncraft._handle_action_result. Cooldown 30s on reminders. **This approach will be replaced by the discard approach below.**

4. **SOUL sections (t_528a39d7, ✅ done)** — Inserted "Embodied Experimental System" + "What I learned in this session is local" in 3 SOUL files (McCompaii, SOUL_daemoncraft, agents/SOUL-base). Also dragged in 6.1 and 6.2 (Verify Before Narrate + Radical Pivot) which were in runtime but never committed in SOUL-base.md.

5. **mc_navigate perception macros (t_8d9a29ba, ⏳ 50% in progress)** — Implemented 5 semantic actions in `agents/bot/lib/mc_navigate.js`: `identify_cave`, `identify_interior`, `find_doors`, `verify_door`, `scan_structure`. Endpoint `/navigate` added to server. Bot server restarted with code. Issue found: bot at (16, 64, -47) in death-trap-zone near mesa_house_2 area — chunks not loaded, `blockAt` returns null. Need chunk loading fix (t_d7b663f3).

6. **Bot escape (manual interaction)** — Nico said "bot clavado contra una esquina de una casa". Read SOUL House Integrity (use doors, don't break walls), used `mc_perceive scene` to confirm geometry (walls S+E, free N+O), moved bot in 3 `mc_move` calls. Bot free at (566.6, 119, -330.5).

### What we DISCUSSED but not yet committed as cards
- **Type-based CJK mapping** (t_bb491366) — replace exact-block CJK (arbitrary, no meaning) with semantic CJK categories (岩=stone, 木=wood, 土=earth, 水=water, 火=fire, etc.). The 90% of cases resolved by visual alone; the 10% (exact block) use `mc_navigate action=verify_block`. CJK is auto-decodable by any LLM with CJK knowledge without consulting a legend.

- **Typed outcome field** (t_a2c3facb) — replace text-match parsing of tool result strings (regex on "cancelled", "no_progress", etc.) with a typed JSON contract: `{ok, outcome, category, target, position_before, position_after, block, details}`. Every consumer (NarrateGateTracker, StuckPivotTracker, mc_navigate) reads the fields directly. Zero substring matchers.

- **Discard ungrounded narrate + visual inject** (t_f8481d90) — REPLACES the reminder approach in t_0fa2c6dc. On mismatch, strip the assistant text (keep tool_use blocks, they're valid), augment the tool_result with a visual pre-process of the affected area (visual of bot's current position + visual of the target cell for mc_move, etc.). Cap at 2 discards per turn.

- **Enriched mc_navigate responses** (t_dd9f607d) — add `access_points` (doors + holes), `missing_blocks` (expected wall + current air = directly actionable for mc_build place), `is_safe` + `safety_issues`, `furni` counts, `hostile_presence`. Default safety_issues: open_door, wall_hole, missing_floor, lava_within_5m, hostile_inside, low_light (only with hostile). NOT issues: no_bed, missing_chest (preferences).

- **verify_block** (t_063009f4) — for the 10% case where exact block name matters. mc_navigate action=verify_block x=...y=...z=... returns `{position, block, category, is_solid, ...}`. Companion to type-based CJK.

- **Geometric macros** (t_4c62f48c) — 5 more actions for mc_navigate: walkable, path_to (fail-fast via pathfinder), corners (corner blocks of walkable space), escape_routes (cardinal directions with distances + blockers + ceiling + light), structure_outline (bounding boxes + classification).

- **mbit3d visualizer SoT** (t_f34e5174) — http://localhost:3003/mbit3d must consume the canonical BLOCK_TO_CHAR mapping (not hardcoded). New endpoint `/navigate?action=visual_legend` exposes the mapping for the visualizer to fetch.

- **Consolidated restart** (t_97b030a6) — bundle all changes that need restart: max_turns=30 (env change), sub-fix 4 (StuckPivotTracker), NarrateGateTracker recording, new SOULs. Drain 60-90s. Kills current L4 session.

- **E2E tests L1-L2-L3-L4** (t_4b04d67e) — the testing scenario Nico proposed at end of session. L1: bot server endpoints. L2: reflex runner. L3: agent loop, trackers, bridge. L4: McCompaii session, SOUL, tools, house integrity, escape, narrate anchoring, verify_block.

### What we DECIDED to NOT do
- **Back compat for old mbit formats** — Nico explicit: "no necesitamos back compatibility. Nuestro actual full no sirve si no es inequívoco." Old formats return 400 Bad Request.
- **CJK as semantic pictograms** — Nico questioned my use of arbitrary CJK and pushed toward semantic categories (岩, 木, 土, etc.) where each char has actual meaning. Recorded as t_bb491366.
- **Reminder injection for narrate gate** — Nico proposed better: "borremos directamente de la historia de chat la respuesta ungrounded, para que no le quede al modelo como contexto". Then refined to: "le inyectemos un perceive y in mcBit o mcBit pre-procesado... algo que le indique: ey acá está el resultado de tu acción". Recorded as t_f8481d90.
- **Maintain large dict in context for mBit decode** — Nico: "resulta menos importante que mantengas un diccionario grande en contexto para interpretar los mBits". Type-based CJK is the fix.

### Current state (end of session 2026-06-02)
- **Bot**: alive at (16.6, 64, -47.5), health 20, netherite gear, full inventory, in death-trap-zone (barrier blocks + TNT nearby per MEMORY), L4 is using `follow` to chase Nico (Nico at 7.2m SW)
- **L4 session**: active, in lab mode, consolidating, in death-trap-zone
- **Services**: daemoncraft (PID 1400670), daemoncraft-cast, hermes-gateway, embodied-service — all active
- **Dispatcher**: `kanban.dispatch_in_gateway: false` (manual mode)
- **Commits not yet pushed**: 0 (DaemonCraft commit 8f5efc1 + visual + SOUL-base; hermes-agent commits 2f9117981 + 8ccc54216 + 2f9117981; all synced via compaii-state)
- **HMK**: chapters 48, 49, 50 (mc-episodic, mc-places) updated with the session events

### Roadmap when Nico returns (priority order)
1. ✅ **t_a2c3facb (typed outcome)** — DONE. Refactored server to return typed JSON; NarrateGateTracker consumes fields directly. 0 substring matchers. Commits + sync + gateway restart done.
2. ✅ **t_bb491366 (type-based CJK)** — DONE. 1166/1166 blocks mapped to 146 distinct CJK chars with actual meaning. LLM auto-decodes. Build script regenerable. Commits + sync done.
3. ✅ **t_d7b663f3 (chunk loading, with caveat)** — DONE. Best-effort code added to /blocks endpoint and mc_navigate.js. But mineflayer 1.21 + prismarine-world 1.21 don't support forced chunk loading from the client side. Distant scans return "unknown" until the bot explores. **Workaround**: walk bot near before scanning distant areas. Live test at bot position (16, 64, -47) works: 禁=barrier, 空=air, 丸=cobblestone, 土=dirt, 灰=concrete, 瓦=terracotta.
4. ✅ **t_dd9f607d (enriched responses)** — DONE. identify_interior + scan_structure return access_points, missing_blocks, furni, hostile_presence, is_safe + safety_issues, volume_blocks. Plus actionVerifyBlock (t_063009f4) for exact block identity. Back-compat preserved.
5. ✅ **t_063009f4 (verify_block)** — DONE (sub-task of t_dd9f607d). actionVerifyBlock returns {position, block, category, is_solid, is_walkable, is_opaque, metadata}. Fills the 10% gap that type-based CJK leaves.
6. ✅ **t_f8481d90 (discard narrate + visual inject)** — DONE (soft-discard approach). When NarrateGateTracker detects past-tense narration contradicting last tool result, gateway injects synthetic world state with reminder text + visual pre-process of radius 4 around bot's position_after (fetched from bot server's /blocks?format=visual). Cooldown 30s. 8/8 unit tests pass. Full discard (strip assistant text from history) would require invasive changes to hermes-cli's conversation_loop.py — too invasive for this bloc.
7. ✅ **t_4c62f48c (geometric macros)** — DONE. 5 new actions: walkable (standable cells with floor check), path_to (pathfinder with 5.5s timeout, fail-fast), corners (NW/NE/SE/SW of walkable area), escape_routes (cardinal directions with distance+blocker+ceiling, best_escape), structure_outline (ceiling-column detector). 11 total actions in dispatcher. Server /navigate updated for async path_to.
8. ✅ **t_97b030a6 (restart consolidated)** — DONE. Killed old L4 session, restarted gateway + daemoncraft-cast, bot server.js reloaded with all 8 card implementations. invoke_hook bug fixed. WS reconnected, L4 auto-resumed with new SOULs. Bot at (17.5, 64, -53.5), health 20/20, food 20/20.
9. ✅ **t_f34e5174 (mbit3d visualizer)** — DONE. mbit-viz3d.html consumes /navigate?action=visual_legend (single source of truth). /blocks returns both text (LLM) and blocks[] with per-block char. Hardcoded CHAR_MAP removed. Tested live: 1166 blocks, 146 chars, chars 禁空灰瓦葉 match server.
10. **t_4b04d67e (E2E tests L1-L2-L3-L4)** — last step, with everything deployed.

### Files to read first when resuming
- `~/Projects/DaemonCraft/MEMORY.md` (this file)
- `~/Projects/DaemonCraft/agents/bot/lib/block_to_char_1.21.9.js` (current CJK mapping)
- `~/Projects/DaemonCraft/agents/bot/lib/mc_navigate.js` (mc_navigate implementations)
- `~/.hermes/profiles/mccompaii/SOUL.md` (L4 SOUL with new sections)
- `~/.hermes/hermes-agent/gateway/platforms/daemoncraft_narrategate.py` (NarrateGateTracker)
- `~/.hermes/hermes-agent/gateway/platforms/daemoncraft_antiloop.py` (StuckPivotTracker sub-fix 4)
- The 11 cards in kanban: 891f8020, 528a39d7, 0fa2c6dc, 436909c6, 8d9a29ba, bb491366, a2c3facb, f8481d90, dd9f607d, 063009f4, 4c62f48c, d7b663f3, 97b030a6, 4b04d67e, f34e5174

### Open question: CJK for type-based mapping
Some type CJKs are still TBD where the semantic mapping is debatable. The list of ~100 CJK types is in t_bb491366 body. Nico may want to adjust specific mappings (e.g. should `terracotta` map to `土` like dirt, or to `瓦` like bricks?).

### Open question: discard cooldown
How many discards per turn before the LLM's narration is allowed through anyway? Proposed cap: 2. If LLM re-narrates incorrectly 3 times in a row, log warning and let it pass to avoid infinite loop.


## System Operations (2026-06-02)

**Controller mode**: `lab` (default as of 2026-06-02). Bot does NOT start
autonomous turns. Only user input (chat message) drives L4. Change with:
`./scripts/daemoncraft-ops.py mode [lab|autonomous]`. Lab mode silences
ALL wake_up triggers (hostile entities, stuck tasks, plan progress) —
nothing fires an L4 turn except human chat. The original autonomous mode
came with a token cost (heartbeat every ~7s, ~600 tokens each) that
Nico flagged as not worth the value when actively observing.

**Operations script**: `scripts/daemoncraft-ops.py` is the single source
of truth for system control. Subcommands: `status`, `mode`, `restart`,
`speak`, `log`, `health`, `session`, `tools`, `watch`. Each shows current
state and accepts the appropriate toggles. Replaces ad-hoc
`systemctl --user restart hermes-gateway` + `curl /controller/mode` +
`tail gateway.log` + `pgrep` sequences. Run `./scripts/daemoncraft-ops.py --help` for full list.

**Why we don't just keep it on autonomous by default**: in autonomous
mode the bot consumes ~10x more tokens (continuous heartbeat responses),
and any stray hostile mob, stuck task, or completed plan triggers a
new L4 turn. When Nico is actively testing, that noise is unhelpful.
Lab mode lets Nico control exactly when the bot acts.
