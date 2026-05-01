# DC-109: Phase 0 Prep

**Status:** backlog  
**Priority:** high  
**Type:** task

## Problem

The second architecture review identified three foundational gaps that must be closed before DC-106/107/108 can ship safely.

## Work

### 1. /agent/interrupt Endpoint

- Add `POST /agent/interrupt` to `server.js`
- On receive, broadcast WS event type `"interrupt"` to all connected clients
- `agent_loop.py` WS handler listens for `"interrupt"` and sets `cancel_event` + `_interrupt_requested`
- Verify this aborts an in-progress LLM turn, not just physical actions

### 2. Plan Epoch / Versioning

- Add `epoch` (integer) field to plan JSON in `server.js`
- Increment epoch on every successful write
- Every plan write must include `expected_epoch`
- Server rejects write with HTTP 409 if `expected_epoch != current_epoch`
- Loop and gateway must handle 409 by refetching plan and re-evaluating

### 3. Loop Prompt Refactor

- Create `BODY.md` (or `ACTIONS.md`) prompt for the loop's AIAgent
- Strip all social/concise persona language
- Pure body/action orientation: look, decide, act, update plan
- The gateway keeps `SOUL.md` for social chat sessions
- Ensure profile loading loads `BODY.md` for loop context

### 4. Remove `mc_chat` from Loop Toolset

- Disable `mc_chat` tool for the loop's AIAgent
- Remove from `enabled_toolsets` or add to `disabled_toolsets`
- Ensure loop cannot emit chat even via explicit tool call

## Acceptance Criteria

- `/agent/interrupt` aborts an in-progress LLM autonomy turn within 2 seconds
- Plan write with stale epoch returns 409, client refetches and retries
- Loop AIAgent has no `mc_chat` tool available
- Loop prompt is body-only, no social persona
- Daemon Guardian (gamemode/effects) still works

## Dependencies

- None. This is Phase 0.

## Blocks

- DC-106 (needs interrupt channel and plan epoch)
- DC-107 (needs interrupt channel and plan epoch)
- DC-108 (needs loop prompt and mc_chat removal)
