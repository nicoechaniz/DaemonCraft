# DC-105: Unified Social Routing — Loop to Gateway Migration (EPIC)

**Status:** in_planning  
**Priority:** high  
**Type:** epic

## Vision

Reduce `agent_loop` to its sole purpose: the proactive tick loop. Move ALL reactive/social responsibility to the Hermes gateway.

- **Gateway = EVERYTHING reactive.** Chat in/out, TTS, quest narration, blueprint narration, plan mutations from player chat, cancel/interrupt signaling, bot-vs-human filtering, @mention classification, cron jobs.
- **Loop = ONLY proactive.** Heartbeat every 30s, sensor polling, quest trigger evaluation, physical tool execution. NEVER speaks to the player.

## Why

Hermes gateway already handles sessions, LLM turns, multi-platform routing, TTS, and cron. The only thing Hermes lacks natively is a proactive tick loop. That is DaemonCraft's unique value. We should not duplicate social capabilities in the loop.

## Work Breakdown

| Ticket | Title | Status | Blocks |
|--------|-------|--------|--------|
| DC-109 | Phase 0 Prep: interrupt channel, plan epoch, loop prompt | backlog | DC-106, DC-107, DC-108 |
| DC-106 | Gateway Event Consumption: quest_event + blueprint_updated | backlog | DC-108 |
| DC-107 | Gateway Chat Ownership: filtering, cancel, plan mutations | backlog | DC-108 |
| DC-108 | Loop Embodiment Cleanup: remove chat, fake injection | backlog | — |

## Migration Order

1. **Phase 0 (DC-109):** Build foundations before any behavior change
   - Add `/agent/interrupt` endpoint + WS `interrupt` event
   - Add plan epoch / version field; reject stale writes
   - Create `BODY.md` prompt for loop (body-only, no social persona)
   - Remove `mc_chat` from loop's toolset

2. **Phase 1 (DC-106 + DC-107 in parallel dev):**
   - DC-106: gateway adapter consumes `quest_event` + `blueprint_updated` from WebSocket
   - DC-107: gateway owns chat filtering, cancel signaling, plan mutations

3. **Phase 2 (sequential rollout with feature flags):**
   - Enable `GATEWAY_HANDLES_QUEST_EVENTS=1` on one bot, soak 24h
   - Enable `GATEWAY_HANDLES_CHAT=1` on one bot, soak 24h
   - Ramp to all bots

4. **Phase 3 (DC-108):**
   - Remove `_post_chat` for player messages
   - Remove fake chat injection (quest_event, blueprint_updated)
   - Quest engine emits events instead of fake chat
   - Remove `MC_ALWAYS_CHAT`
   - Verify all 4 casts (companion, landfolk, civilization, rolemaster)

## Acceptance Criteria

1. Player whisper/broadcast → gateway responds with TTS + chat, loop stays silent
2. Player @mention during loop action → gateway interrupts loop, then responds
3. Quest phase transition → gateway narrates, loop continues with new phase state
4. Blueprint dashboard save → gateway narrates, loop reloads blueprint
5. Loop heartbeat runs silently (no chat) when no player activity
6. No duplicate responses across any cast

## Files

- `docs/design/daemoncraft-platform-adapter.md`
- `agents/agent_loop.py`
- `agents/bot/server.js`
- `gateway/platforms/daemoncraft.py`
- `agents/quest_engine.py` (new, extracted from loop)
