# DC-107: Gateway Chat Ownership

**Status:** backlog  
**Priority:** high  
**Type:** task

## Problem

The agent_loop currently owns reactive chat responsibilities that belong in the gateway: bot-vs-human filtering, @mention classification, cancel/interrupt signaling, and plan mutation from player chat.

## Work

1. **BOT FILTERING:** Move bot-vs-human and @mention classification from `agent_loop.py` (lines ~319-359) into the gateway adapter. The adapter decides:
   - Ignore bot-to-bot chatter without @mention
   - Queue non-urgent messages
   - Treat @mention as urgent (triggers turn immediately)
   - Filter self-echo (`from == bot_username`)
   - Port `KNOWN_BOTS` awareness into adapter

2. **CANCEL SIGNALING:** When gateway receives urgent @mention, POST `/agent/interrupt` (new endpoint from DC-109) BEFORE generating AI response. This aborts the loop's in-progress LLM turn cleanly.

3. **PLAN MUTATIONS:** Gateway must write to `/plan` endpoint when player makes actionable requests ("bring me wood", "build a house").
   - Use plan epoch from DC-109 to avoid race conditions
   - Gateway handles 409 stale-epoch by refetching
   - This solves the commitment problem: gateway promises → plan updates → loop discovers on next heartbeat

4. **PLAYER CHAT ROUTING:** Gateway becomes sole owner of player-facing chat. Loop `_post_chat` must not fire for player messages (handled in DC-108).

## Acceptance Criteria

- @mention during loop action → loop interrupts → gateway responds
- Player request with actionable intent → gateway sets plan → loop executes on next heartbeat
- Bot-to-bot chatter without @mention → ignored by gateway, no turn triggered
- Self-echo filtered correctly
- Plan epoch prevents stale writes

## Dependencies

- **Blocked by:** DC-109 (interrupt endpoint and plan epoch must exist)
- **Blocks:** DC-108

## Feature Flag

Ship behind `GATEWAY_HANDLES_CHAT=1` (default off). Roll out per-bot.
