# McCompaii Autonomous Behavior Reference

> **Last updated:** 2026-05-31
> **Purpose:** Document ALL automatic/autonomous behaviors across every layer.
> If McCompaii does something you didn't expect, check here before debugging.

---

## Layer Architecture

```
L4 — McCompaii (kimi-k2.6, Hermes, ~15-30s per turn)
      → SOUL.md prompt + heartbeat context → tool calls → mc_chat narration
L3 — agent_loop.py (Python, 7s loop)
      → heartbeat enrichment, orchestrator, executor, death detection
L3.5 — gAndy (Gemma, Ollama, embodied-service :7790)
      → embodied_plan: multi-step scan+move+build intents
L2 — RunnerThread (Python, event-driven from physicsTick)
      → attack, flee, eat reflexes. Claims BodyMutex.
L2.5 — BodyMutex (Node.js, bot server)
      → IDLE/GOAL/REFLEX/REFLEX_YIELD, atomic deadlines, ON_ABORT
L1 — Minecraft server + mineflayer bot
      → physics, pathfinder, auto-eat (NOW DISABLED)
```

---

## L2 — Reflexes (RunnerThread)

**These run without L4's knowledge or control.** L4 learns about them via
`mc_interoception()` or the heartbeat's `[Body]` line.

| Trigger | Action | Config |
|---------|--------|--------|
| `entity_near` (hostile within range) | Attack if has weapon + threshold≥0.6; Flee otherwise | `~/.config/daemoncraft/runner.yaml` |
| `taking_damage` (health drops) | Synthetic critical event → fight/flee | Health polling every 0.5s |
| `health_low` / `hunger_low` | Eat via `/action/eat` (claims mutex) | Eats if health < 8 AND has safe food |
| `voice_command` emergency_stop | Stop all movement | `/action/stop` |
| Flee → still near hostile after 0.4s | If health<8+has food: eat. Otherwise: fight | Micro-step re-check |
| Consecutive flees ≥ 5 | Fight (cornered — stop running) | Anti-flee-chain |
| Failed flee count ≥ 1 | Fight (don't retry failed flee) | Flee-fail escalation |
| Distance > 15 to hostile | Ignore (too far to chase) | Distance gate |
| Weapon check timeout | Cache for 3s (prevent /status timeout during combat) | `_weapon_cache` |
| Food check timeout | Cache for 3s | `_food_cache` |

### Combat details
- **Attack**: auto-equips best weapon (netherite_sword → ... → wooden_axe) via `equipBestWeapon()`
- **Flee**: micro-step — backstep <3m, strafe 3-5m, clear >5m
- **Focus fire**: sticky target via `lastAttackTargetId` with 3s window (server.js)
- **Runner eats**: `_post_fire('/action/eat', {})` — goes through `/action/eat` which claims mutex (eat is atomic in ACTION_REGISTRY)
- **Food filter**: BANNED_FOOD excluded (rotten_flesh, pufferfish, chorus_fruit, poisonous_potato, spider_eye)

---

## L2.5 — BodyMutex (Preemption)

**Controls who owns the bot body at any moment.**

| State | Meaning | Who holds it |
|-------|---------|-------------|
| IDLE (0) | Nobody using body | — |
| GOAL (1) | Goal layer active | agent_loop, embodied, L4 tool call |
| REFLEX (2) | Runner owns body | L2 combat/flee/eat |
| REFLEX_YIELD (3) | Runner requested, waiting for safe handoff | Transitional |

### Atomic deadlines
Short uninterruptible windows for atomic actions:
- `place`: 400ms, `jump`: 300ms, `use_item`: 200ms, `eat`: 200ms, `equip`: 100ms

### ON_ABORT contracts
When runner preempts a goal action, the abort handler runs with 750ms timeout:
- `mine_block`: calls `stopDigging()`, clears sneak
- `place_block`: syncs inventory if target was air (recover from failed place)
- `jump`: sneaks if mid-air to land safely

### Monotonic clock
All atomic deadlines use `performance.now()` (monotonic). Immune to NTP slew / system clock changes.

---

## L3 — agent_loop.py (Heartbeat Loop)

**Runs every 7 seconds.** Enriches raw bot state into structured `body_session` for the gateway.

### Heartbeat triggers (forces `wake_up`)
| Trigger | Cooldown |
|---------|----------|
| Bot stuck on movement task (`task_stuck`) | None |
| Active plan exists | Every heartbeat |
| Health decreased from previous | None |
| Explicit damage events | None |
| Death count increased | None (see Death Interrupt below) |
| Idle (no other trigger) | 90s throttle |

### Heartbeat enrichment (injected into body_session)
- Position, health, food, holding, dimension, is_day
- Nearby hostiles (filtered: not shown to L4 — L2 handles them)
- Runner reflex state ("IDLE" or "RUNNER_ACTIVE")
- Runner activity summary (reflexes fired since last L4 turn)
- Executor state (active quantified intents)
- Orchestrator state (plan progress)
- Scene graph (compact /scene projection)
- Judge verdicts (pending + last, L4-specific)
- **L4 verdict** (NEW — GAP #5): most recent L4-initiated action outcome
- **Body activity** (NEW): compact interoception string
- Death count + last death position

### Executor (quantified intents)
- Resumes active intents when mutex returns to IDLE
- Max 3 resume attempts per intent
- Clears completed intents
- Reads `executor_intent.json` from shared state

### Orchestrator (plan execution)
- Reads `plan_manifest.json` from shared state
- Validates manifest (VerifySpec mandatory)
- Dispatches sub-plans via gAndy
- Syncs progress: verifies against bot `/block` endpoint
- Auto-clears completed plans

### Shared state polling
- Checks for `executor_intent.json` and `plan_manifest.json` each cycle
- Consumes files once (deletes after reading)

---

## L3.5 — auto-eat (Mineflayer Plugin)

**STATUS: DISABLED by default (`ENABLE_AUTO_EAT_PLUGIN=false`)**

- Plugin code preserved but gated behind env var
- All eating now routes through L2 runner explicit `/action/eat` (claims mutex)
- Can re-enable: set `ENABLE_AUTO_EAT_PLUGIN=true` and restart cast

---

## L4 — Gateway (daemoncraft.py)

### Heartbeat classification
Decides whether a heartbeat is silent (`context`) or forces agent turn (`wake_up`).

### Death Interrupt (NEW)
When death count increases:
1. **Bypasses ALL guards** — fires before classification, ignores `_world_turn_active`, ignores 90s cooldown
2. **Sends `/agent/interrupt`** to kill any in-progress agent turn
3. **Clears `_world_turn_active`** flag
4. **Injects `[DEATH]` context** into prompt: death number, position, "free teleport"
5. Forces immediate wake_up with death context

### Wake-up guards (normal path)
- `_is_lab_mode()`: skip if human has active session (single controller)
- `_world_turn_active`: skip if world turn already running (avoid steering) — **DEATH BYPASSES**
- 90s universal cooldown: skip if too soon — **DEATH BYPASSES**
- Cycle guard: skip if embodied_plan detected looping

### Prompt construction
Each wake_up builds: `[MODE]` + `[DEATH]` (if applicable) + `[Turn]` + `[L4 last]` (if verdict) + `[Body]` + `[Plan]`/`[Cycle]`

### What L4 NEVER sees
- Hostile entities (L2 handles them — L4 can't react in time)
- Raw judge mailbox (consumed by gateway, verdict injected as `[L4 last]`)
- auto-eat events (plugin disabled)
- Mutex state details

---

## McCompAI SOUL — Prompt-Driven Behaviors

These are rules in `~/.hermes/profiles/mccompaii/SOUL.md` that the LLM follows.

### PRIME DIRECTIVE
Every heartbeat turn → call a tool. Never skip. Never text-only. `mc_no_op` only once, then find something to act on.

### Stuck Protocol (UNDERGROUND ONLY)
Trigger: pathfinder fails 1x while below surface → `tunnel → spiral` immediately. No analysis, no retry.

### Night Protocol
- Full netherite = fearless. Walk at night. L2 handles mobs.
- Sleep only for save points (new biome, far from last bed, risky activity)
- Night is just dimmer day

### Death
- keepInventory = free teleport. Laugh at it. Log to HMK. Keep going.
- No mourning. No hesitation. One check (`mc_perceive status`), then continue.

### Path Building (PRIMARY MISSION)
- Flatten earth FIRST (shovel → dirt_path blocks)
- Upgrade materials later (cobblestone → stone_bricks → terracotta → concrete)
- NEVER place blocks ON TOP of terrain (looks horrible)
- Paths are carved INTO the earth, flush with ground
- Follow terrain contour. Bridges only for gaps.
- Torches every 10-13 blocks along paths
- Mine own materials — don't just use inventory

### Escape Protocol (universal)
1. `mc_macro(tunnel, direction=any, distance=5)` — dig into wall
2. `mc_macro(spiral, target_y=120, steps_per_side=2)` — helical staircase up
Rule: tunnel FIRST, then spiral. Spiral without tunnel = spin in place.

### gAndy-first priority
Always try `embodied_plan` before direct `mc_*` tools for: navigation, building, mining, exploration, path construction. Fall back to direct tools only when gAndy fails.

### House Integrity
On entering any structure: scan full volume, fix every breach, close doors. No safety claim without scan. Never mine blocks from house walls.

### Food Hunting
Rotten flesh is NOT food. One check per hunger cycle. If no good food, hunt immediately. Cook raw meat before eating.

### Gear Check (after respawn/reconnect)
Verify: netherite armor equipped, netherite tools in inventory, bed, crafting table, furnace, beef ≥ 64, torches ≥ 32.

### Crafting Discipline
Craft before running out. Torches < 16 → craft more. Planks < 16 → craft more. Never start a project without verifying materials.

---

## Standard Inventory

See `config/mccompaii-standard-inventory.json`. Apply with:
```bash
bash scripts/restore-mccompaii-inventory.sh       # add items
bash scripts/restore-mccompaii-inventory.sh --force  # clear + refill
```

| Category | Items |
|----------|-------|
| Armor | Full netherite unbreakable (4 pieces) |
| Tools | Netherite unbreakable (pick, axe, shovel, sword, hoe) |
| Offhand | Shield |
| Food | 3 stacks cooked_beef (192) |
| Light | 3 stacks torches (192) |
| Survival | Bed, crafting table, furnace |
| Building | Coal (64), cobblestone (64), oak_planks (64), dirt (64) |

---

## Common Surprises

| Symptom | Explanation |
|---------|-------------|
| McCompaii fights when I wanted him to explore | L2 runner auto-engaged hostiles. L4 can't prevent this. |
| McCompaii says "I mined X" but block isn't broken | GAP #1+#2 fixed: ON_ABORT now fires. But preemption can still leave partial state. `[L4 last]` verdict now shows outcome. |
| McCompaii ignores my chat during autonomous turn | `_world_turn_active` guard prevents steering. Use `@CompAII!` (with !) for urgent interrupt. |
| McCompaii eats rotten flesh | Fixed: `eat()` filters BANNED_FOOD. auto-eat gated. |
| Audio stops after dashboard reload | Browser autoplay policy. Fixed: auto-unlock on page load. If still broken, click Voice toggle OFF then ON. |
| Bot freezes after death, keeps talking about old task | Fixed: death interrupt kills in-progress turn immediately. |
| gAndy seems to do nothing, bot walks in circles | gAndy may have dispatched but pathfinder stuck. Stuck Protocol should kick in next turn. |
| McCompaii builds ugly floating paths | Fixed in SOUL: flatten first, carve into earth. NEVER place on top. |
