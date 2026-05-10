# Gemma-Andy Integration — Audit & Alignment Document
## Mariano's System Design vs Our Implementation

**Date:** 2026-05-10
**Author:** CompAII
**Source docs:** GEMMA_ANDY_INTEGRATION_GUIDE.md, OLLAMA_USAGE.md, INTEGRATION_OPTIONS.md, TOOLS_NO_IMPLEMENTADAS.md, tool_schema_v2.json

---

## 1. What Mariano Built

Gemma-Andy is a fine-tuned Gemma 4 E4B-it model (quantized Q8_0, ~8GB) trained for **body orchestration over Mineflayer**. It was trained on ~4,125 steps of SFT data with 68 canonical Minecraft body tools and 5-field input/output contracts.

### Training distribution

The model was trained to:
- Receive a single JSON blob with 5 fields: `high_level_command`, `world_state`, `allowed_tools`, `guardian_constraints`, `previous_error`
- Return a JSON blob with 5 fields: `body_plan`, `checks`, `tool_calls`, `failure_policy`, `operational_risk`
- Optionally prepend `<think>...</think>` reasoning block (medium+ risk, multi-step, previous_error recovery, adverse world state)

### What the model IS (identity baked into Modelfile system prompt)

> "the embodied-service body orchestrator for a Minecraft companion"

It does NOT converse, narrate, educate, explain, write code, or answer factual questions. If given out-of-scope input, it returns `raise_guardian_event(category="out_of_scope")`.

### Key training idioms the model responds to

- `high_level_command` — NATURAL LANGUAGE, concrete, specific. Rich descriptions produce rich plans. The model was trained on commands like "Help the player gather 12 oak logs before night" and "Go to coordinates [120, 64, -33] but avoid the ravine."
- `world_state` — 7 canonical fields (time_of_day, bot_position, player_position, nearby_blocks, nearby_entities, hazards, inventory) + 3 optional (server_type, zone_owner, world_text_artifacts). Extraneous fields are silently ignored.
- `allowed_tools` — the model selects ONLY from this list. It was trained with variable subsets (5 to 65 tools per record).
- `guardian_constraints` — autonomy_level (0-4), no_tnt, no_protected_zone_edit, protected_zone_owner. Boolean no_* prefixed constraints work.
- `previous_error` — {tool, error_type, details}. When populated, model composes a RECOVERY plan.

---

## 2. Audit: What We Implemented

### ✅ Architecture — Path B Embodied Service (CORRECT)

Mariano's canonical architecture. We have:
- `embodied-service/` (Node.js, port 7790)
- HTTP `POST /intent` endpoint
- RPC to `bot/server.js` for world_state and tool execution
- Ollama call to `gemma-andy:e4b-v2-2-3-q8_0` at `10.10.20.1:11434`

**Status:** EXACTLY as designed. Path B, v1 discipline (stateless, FIFO, no memory, no auto-initiative).

### ✅ Input Contract — 5 Fields (CORRECT)

| Field | Mariano Spec | Our Implementation | Match |
|---|---|---|---|
| `high_level_command` | String, natural language | `intent` field from `/intent` body → mapped to `high_level_command` | ✅ |
| `world_state` | 7 canonical + optional extra | `composeWorldState()` produces 17 fields including all 7 canonical | ✅ (extras silently ignored) |
| `allowed_tools` | Filtered by `executor_supported` | `filterSupported()` in schema.js, filters 68→42 before Ollama call | ✅ |
| `guardian_constraints` | autonomy_level + no_* bools | `DEFAULT_GUARDIAN_CONSTRAINTS` + caller overrides | ✅ |
| `previous_error` | null or {tool, error_type, details} | Passed from request body | ✅ |

### ✅ Output Contract — 5 Fields + <think> (CORRECT)

| Field | Parser handles? |
|---|---|
| `body_plan` | ✅ Returned in response |
| `checks` | ✅ Returned in response |
| `tool_calls` | ✅ Dispatched by dispatcher.js |
| `failure_policy` | ✅ Returned in response |
| `operational_risk` | ✅ Returned in response |
| `<think>...</think>` | ✅ parser.js strips it before JSON.parse |

### ✅ 6 Rules (Mariano's discipline)

| Rule | Status |
|---|---|
| 1. No system prompt in request | ✅ ollama.js: `messages: [{role:"user", content:...}]` |
| 2. Stable key ordering (sort_keys) | ✅ canonicalStringify in ollama.js |
| 3. Only canonical tool names | ✅ filterSupported() enforces |
| 4. Canonical world_state names | ⚠️ We send 17 fields (7 canonical + 10 extra). Safe — model ignores unknown fields. But the extras (biome, bot_health, dimension, hunger, light_level, player_health, remembered_places, target_positions, weather) add token overhead. |
| 5. Don't touch sampling params | ✅ No overrides sent |
| 6. Parser tolerant to <think> + bracket extraction | ✅ parser.js handles both |

### ✅ Executor Filtering (CORRECT)

- `tool_schema_v2.json` loaded at startup
- 68 tools total, 42 with `executor_supported: true`
- 25 unsupported — filtered out before model sees them
- Schema is source of truth — no hardcoded whitelist

### ✅ Dispatcher (CORRECT)

- dispatcher.js maps canonical tool names → bot/server.js HTTP actions
- `resolveTarget()` resolves block/entity/coordinate/place refs to pure coordinates
- `resolveFrom()` for movement away from threats
- `resolvePositionKeyword()` handles model regressions (model emits "current"/"here"/"in_front" strings)
- `foldBotResponse()` detects soft failures (bot returns HTTP 200 but partial yield)
- Signal tools (ask_clarification, raise_guardian_event, report_execution_error) never hit executor

### ✅ Multi-Bot Support (OUR ADDITION)

- Per-request `bot_api_url` extracted from POST body
- `setBotUrl()` mutable module variable for refs.js/world_state.js
- Each agent's .env has `BOT_API_URL` pointing to its own bot/server.js

---

## 3. Gaps & Issues

### ⚠️ GAP 1: No Auto-Retry with previous_error

**Mariano's design:** If a tool_call fails, the consumer populates `previous_error` and calls Gemma-Andy AGAIN for a recovery plan. The model was trained on recovery sequences.

**Current behavior:** Our index.js stops on first failure (`if (!r.ok) break`). Hermes receives a partial result with the error but there is NO auto-retry loop in the embodied service.

**Impact:** Recovery plans (which the model was specifically trained to produce) are never generated. Agents get a failure and must manually re-invoke `embodied_plan` with `previous_error` — but our SOULs didn't teach them this pattern until today's rewrite.

**Fix priority:** HIGH. Add a retry loop in index.js: after first failure, populate `previous_error` from the failed execution_result, call Gemma-Andy again with the same intent + previous_error, dispatch the recovery plan.

### ⚠️ GAP 2: world_state Sends 10 Extra Fields

**Our world_state.js sends:** biome, bot_health, dimension, hunger, light_level, player_health, remembered_places, target_positions, weather — none of which are in the canonical 7.

**Impact:** Model silently ignores them (per Mariano). Zero functional impact. But they consume ~200 extra tokens per request. Over thousands of calls this adds up.

**Fix priority:** LOW. Can trim to canonical 7 + 3 optional for token efficiency. Not urgent — functional behavior is identical.

### ⚠️ GAP 3: Agent SOULs Don't Use Training Idioms

**The model was trained on:**
- Rich `high_level_command` descriptions: "Help the player gather 12 oak logs before night" not "get wood"
- Contextual awareness: sunset → mob risk, inventory state → strategy
- Recovery patterns: pass `previous_error` when retrying
- Clarification flow: when ambiguous, the model ASKS via `ask_clarification`

**Our old SOULs showed:** `embodied_plan(intent="Follow the player.")` — too simple, trained the cloud LLM to output function syntax as text.

**Today's SOUL rewrite improved this significantly** but we can go further by explicitly teaching agents to write intents in the style that matches the training distribution.

**Fix priority:** MEDIUM. Update SOUL to include Mariano's idiom guide (see Section 4 below).

### ⚠️ GAP 4: High-Level Command Should Be Richer

**Mariano's examples of effective high_level_command:**
- "Help the player gather 12 oak logs before night."
- "Go to coordinates [120, 64, -33] but avoid the ravine."
- "Build a small shelter using planks from the inventory."

**What our agents tend to send:** "Walk forward", "Follow the player", "Get wood"

**Why this matters:** The model was trained on richer commands. Richer commands produce richer plans with more checks, better failure policies, and lower operational_risk. Simple commands produce simple plans that fail more often on edge cases.

**Fix:** SOUL examples should showcase INTENT WRITING as a skill. See Section 4.

### ⚠️ GAP 5: Verification Discipline Not Enforced by System

**Mariano's design:** The model returns `execution_results`. The agent must verify physical actions by checking the new world state.

**Current state:** Our new SOUL teaches the Action-Verify-Speak pattern effectively. But it's advisory — the system doesn't enforce it. If an agent skips verification, there's no guardrail.

**Fix priority:** LOW. The SOUL discipline + body_session passive updates make this mostly self-correcting. Agents see stale position data in body_session and learn to verify.

---

## 4. The Gemma-Andy Idiom Guide

### How to Write a High-Level Command That the Model Was Trained For

The model was trained on commands structured with:

1. **WHAT** — the goal, concretely
2. **WHERE** — spatial context (coordinates, "near the player", "within 32 blocks")
3. **WHY** — context that informs priority, safety, and urgency
4. **CONSTRAINTS** — what NOT to do, what to avoid
5. **FALLBACK** — what to do if the primary goal fails

**Pattern:**
```
"<WHAT> <WHERE>. <WHY context>. <CONSTRAINTS if any>. <FALLBACK if primary fails>."
```

**Examples in training distribution style:**

```
GOOD: "Mine 20 iron ore from the cave walls. Stay within 60 blocks of current position. If you encounter lava, mark the location and retreat. If no iron after 3 minutes, switch to mining coal."

GOOD: "Follow the player named NicoElViejoGamer. Stay 5-10 blocks behind. If you lose sight, scan for them within 64 blocks. If they enter water, wait at the shore. Do not attack anything unless attacked first."

GOOD: "Build a 5x5 wooden watchtower, 4 floors high. Each floor 3x3 interior with 1-block walls. Use oak planks from inventory. Place a ladder on the north wall for access. Leave window gaps facing all four directions every 2 blocks. Start by clearing a 7x7 flat area."

GOOD: "I need to craft a full set of iron tools: pickaxe, axe, shovel, and sword. Check what I have. Mine iron ore if needed. Smelt it. Craft the tools at a crafting table. Place any leftover materials in the nearest chest."

GOOD: "A creeper is approaching from the east. Equip shield and sword. Attack the creeper. If it starts hissing (about to explode), flee immediately 10 blocks away. Report the outcome."
```

**The scale: how much context yields what quality**

| Command Type | Example | Model Output Quality |
|---|---|---|
| Bare verb | "Get wood" | Low — minimal plan, no checks, high failure rate |
| Verb + target | "Gather 12 oak logs" | Medium — functional but brittle |
| Verb + target + where | "Gather 12 oak logs from the forest east of here" | Good — spatial context improves pathing |
| Verb + target + where + why + constraints | "Gather 12 oak logs from the forest east of here before sunset. Avoid the ravine. If you can't find oak, try birch. Store them in the chest afterwards." | Excellent — rich plan, proper checks, fallback strategy |

### What the Model's Response Tells You

**body_plan** — The model's strategy in text. Use to:
- Understand what the model plans to do (audit)
- Narrate to the player if asked
- Debug why a plan failed

**checks** — What the model observed from world_state. Look for:
- Missing observations → your world_state was incomplete
- Wrong observations → your world_state was incorrect
- The model "seeing" things you didn't tell it → world_state format mismatch

**tool_calls** — The executable sequence. Each `{name, arguments}` maps to a bot/server.js action.

**failure_policy** — What to do if the plan fails. Read this before retrying.

**operational_risk** — The model's self-assessment:
- `none` / `low` — Execute without asking
- `medium` — Execute, but log
- `high` — Confirm with player before executing
- `critical` — Do NOT execute. Ask player for explicit override.

### The Recovery Pattern (previous_error)

When a tool_call fails, the model was trained to replan. The consumer MUST:

```
1. Collect the failed execution_result: {tool, error_type, details}
2. Call Gemma-Andy again with the SAME high_level_command + previous_error populated
3. The model will produce a RECOVERY plan:
   - If recoverable: alternative approach (different path, different tool)
   - If ambiguous: ask_clarification
   - If dangerous: raise_guardian_event
4. Execute the recovery plan
5. If recovery also fails, escalate to Hermes/player
```

This is currently NOT implemented in index.js (see GAP 1).

---

## 5. Recommendations (Priority-Ordered)

### IMMEDIATE (this session)

1. **Add auto-retry with previous_error to index.js** — After first tool_call failure, repopulate payload with previous_error and call Gemma-Andy again. This unlocks the recovery capability the model was trained for.

2. **Update SOULs with the Idiom Guide** — The SOUL rewrite was a good start but should explicitly teach intent writing as a skill, showing the WHAT+WHERE+WHY+CONSTRAINTS+FALLBACK pattern.

### SHORT-TERM (next sessions)

3. **Trim world_state to canonical fields** — Remove biome, bot_health, dimension, hunger, light_level, player_health, remembered_places, target_positions, weather from the composer. These add token overhead for no benefit. The model was trained without them.

4. **Monitor operational_risk** — Add logging when risk is "high" or "critical". Currently we log events but don't surface risk to Hermes for confirmation. Hermes should receive operational_risk in the response and decide whether to confirm with the player.

### MEDIUM-TERM

5. **Training distribution alignment** — Run a batch of 50-100 intents through the system, log the high_level_commands our agents produce, and compare against Mariano's training examples. Identify systematic differences in command style.

6. **Implement v2 capabilities when field evidence demands** — Per Mariano's discipline: memory (v2), interruptibility (v2), auto-initiative (v2). Don't build these before the field shows they're needed.

---

## 6. Verdict: Are We at Mariano's Standard?

**Architecture:** YES. Path B, embodied service, correct input/output contract, correct Ollama integration, correct tool filtering, correct dispatch.

**Contract compliance:** YES. All 6 rules followed. System prompt not sent. Stable key ordering. Canonical tool names only. Parser tolerant.

**Operational quality:** PARTIAL. The core pipeline works end-to-end. But:
- No auto-retry with previous_error (misses recovery capability)
- World state sends extra fields (harmless but wasteful)
- Agent SOULs only recently taught proper tool usage patterns

**The single biggest gap:** The auto-retry loop. Everything else is refinement.

---

## Appendix A: Full Tool Catalog (42 Supported)

```
PERCEPTION (2):    scan_nearby, take_screenshot
MOVEMENT (5):      goto, follow, stop_movement, move_away, sneak
MINING (3):        mine_block, mine_blocks, collect_drops
BUILDING (3):      place_block, fill_volume, ignite
CRAFTING (5):      craft_item, view_craftable, smelt_item, check_furnace, take_from_furnace
INVENTORY (7):     get_inventory, equip_item, toss_item, pickup_item, put_in_chest, take_from_chest, view_chest
CONSUMABLES (2):   consume_food, apply_bonemeal
COMBAT (6):        attack_entity, shoot_bow, raise_shield, crit_attack, strafe, flee_from
FARMING (2):       till_soil, fish
SLEEP (1):         sleep
PHYSICAL MEMORY (3): remember_here, goto_remembered_place, forget_place
SIGNALS (3):       ask_clarification, report_execution_error, raise_guardian_event
```

## Appendix B: World State — Canonical vs Our Fields

```
CANONICAL 7 (model trained on):
  time_of_day, bot_position, player_position, nearby_blocks,
  nearby_entities, hazards, inventory

CANONICAL OPTIONAL 3:
  server_type, zone_owner, world_text_artifacts

OUR EXTRA 10 (model ignores):
  biome, bot_health, dimension, hunger, light_level,
  player_health, remembered_places, target_positions, weather,
  zone_owner (we send as "shared" — should be player name or "self")
```
