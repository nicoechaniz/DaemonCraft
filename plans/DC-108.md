# DC-108: Loop Embodiment Cleanup

**Status:** backlog  
**Priority:** high  
**Type:** task

## Problem

After DC-106 and DC-107, the gateway owns all reactive social behavior. The loop must be stripped of everything that is not proactive body/action.

## Work

1. **DISABLE PLAYER CHAT:** Remove or gate `_post_chat` calls for player-originated messages. Keep `_post_chat` ONLY for:
   - Explicit `mc_chat` tool calls from the loop (but see below: we are removing the tool)
   - Tool error reporting (decide if these go silent or to dashboard only)

2. **DISABLE FAKE CHAT INJECTION:**
   - Remove `quest_event` fake chat injection (`agent_loop.py` lines ~369-376)
   - Remove `blueprint_updated` fake chat injection (`agent_loop.py` lines ~360-367)
   - These events now route through the gateway (DC-106)

3. **QUEST ENGINE REFACTOR:**
   - Keep quest trigger evaluation in the loop (it needs periodic world state checks)
   - Change output: instead of `pending_messages.append(fake chat)`, emit event to gateway
   - Use POST to bot API `/event/emit` or WebSocket broadcast, consumed by gateway adapter
   - Consider extracting `_quest_engine_loop` to `agents/quest_engine.py` as importable module

4. **REMOVE `mc_chat` TOOL:**
   - Remove `mc_chat` from loop's `enabled_toolsets` (or add to `disabled_toolsets`)
   - Loop cannot emit chat even via tool call

5. **CLEANUP:**
   - Remove `MC_ALWAYS_CHAT` env var and its usage
   - Remove `_post_chat` call site at `agent_loop.py:1020-1029`
   - Ensure loop uses `BODY.md` prompt (from DC-109), not `SOUL.md`

6. **VERIFICATION:**
   - Test all 4 casts: companion, landfolk, civilization, rolemaster
   - Confirm no duplicate responses
   - Confirm loop heartbeat runs silently
   - Confirm quest phase transitions still work end-to-end

## Acceptance Criteria

- Loop never sends chat in response to player messages
- Loop still runs autonomy heartbeat every 30s
- Loop still executes tools, polls sensors, evaluates quest triggers
- Quest events reach gateway and generate narration
- Blueprint updates reach gateway and generate narration
- Zero references to `MC_ALWAYS_CHAT`
- `mc_chat` tool is not available to loop AIAgent

## Dependencies

- **Blocked by:** DC-106, DC-107

## Rollout

Flip feature flags `GATEWAY_HANDLES_QUEST_EVENTS=1` and `GATEWAY_HANDLES_CHAT=1`.
Remove legacy paths. Clean up dead code.
