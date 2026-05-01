# DC-106: Gateway Event Consumption

**Status:** backlog  
**Priority:** high  
**Type:** task

## Problem

The gateway adapter (`gateway/platforms/daemoncraft.py`) receives ALL WebSocket messages from the bot API but silently drops any payload where `type != "chat"`. Quest events and blueprint updates are broadcast over the same WebSocket but ignored.

## Work

1. In `daemoncraft.py` `_on_ws_message`, branch on `payload["type"]`:
   - `"chat"` → existing handler
   - `"quest_event"` → build `MessageEvent(internal=True)` and `await self.handle_message(event)`
   - `"blueprint_updated"` → build `MessageEvent(internal=True)` and `await self.handle_message(event)`
2. Determine session routing: quest/blueprint events should route to the bot's current world session (broadcast session), not a per-player whisper session.
3. Add logging for dropped/unknown event types.

## Acceptance Criteria

- Gateway receives `quest_event` and generates a natural-language response via AIAgent
- Gateway receives `blueprint_updated` and generates a natural-language response
- Loop still receives these events (we are not yet disabling loop handling)
- No errors in gateway logs for unknown event types

## Dependencies

- **Blocked by:** DC-109 (loop prompt and toolset changes must be ready first)
- **Blocks:** DC-108

## Feature Flag

Ship behind `GATEWAY_HANDLES_QUEST_EVENTS=1` (default off). Roll out per-bot.
