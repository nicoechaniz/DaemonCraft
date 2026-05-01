# Design Proposal: DaemonCraft as an Embodied Hermes Platform

## Status
DRAFT v5 — revised after critical review #4 (Opus). whisper/private mapping corrected, schema split, init values fixed.

## Philosophical Shift: Hermes as Agent Embodiment

This project tests the limits of Hermes as a tool for **agent embodiment**, not merely chat platform integration. The agent is a multi-dimensional intelligence with multiple "cones of consciousness":

- **Minecraft body** — spatial presence, movement, building, mining
- **Voice / TTS** — audio output via dashboard (and future mic input)
- **Vision** — camera / screenshot input
- **Social layer** — Telegram, Discord, and now Minecraft chat

The Hermes gateway is the **social routing layer** for the agent's consciousness. It is already running for every agent profile (otherwise Pamplinas could not send Telegram messages). Adding Minecraft as a gateway platform is not overkill — it is **free** because the infrastructure already exists.

`agent_loop.py` does not disappear. It becomes the **embodiment / autonomy loop** — the heartbeat that keeps the Minecraft body alive, handles quest engines, sensors, and idle behavior. The gateway adapter is the **messaging / social cone** that routes player chat through the agent's cognition.

---

## Revised Architecture: Coexistence

```
                    ┌──────────────────────────────────────┐
                    │         Hermes Gateway               │
                    │  (already running per profile)       │
                    └──────────────┬───────────────────────┘
                                   │
        ┌──────────────────────────┼──────────────────────────┐
        │                          │                          │
        ▼                          ▼                          ▼
┌───────────────┐      ┌─────────────────────┐      ┌──────────────┐
│  Telegram     │      │  DaemonCraftAdapter │      │   Discord    │
│  (existing)   │      │  (NEW — this doc)   │      │  (existing)  │
└───────┬───────┘      └──────────┬──────────┘      └──────┬───────┘
        │                         │                        │
        └─────────────────────────┼────────────────────────┘
                                  │
                                  ▼
                    ┌─────────────────────────┐
                    │      AIAgent            │
                    │  (gateway-managed)      │
                    └───────────┬─────────────┘
                                │
                    ┌───────────┴───────────┐
                    │                       │
                    ▼                       ▼
        ┌──────────────────┐    ┌─────────────────────┐
        │ agent_loop.py    │    │  agent_loop.py      │
        │ (Minecraft body) │    │  (mic/camera loop)  │
        │ • pathfinding    │    │  • voice input      │
        │ • quest engine   │    │  • vision input     │
        │ • sensors        │    │  • future sensors   │
        │ • idle behavior  │    │                     │
        └────────┬─────────┘    └─────────────────────┘
                 │
                 ▼
        ┌──────────────────┐
        │  Bot API (3002)  │
        │  • /action/*     │
        │  • /chat/send    │
        │  • /agent/log    │
        │  • /tts/play     │
        │  • /ws events    │
        └────────┬─────────┘
                 │
                 ▼
        ┌──────────────────┐
        │  Mineflayer Bot  │
        └────────┬─────────┘
                 │
                 ▼
        ┌──────────────────┐
        │  Minecraft Server│
        └──────────────────┘
```

**Key insight:** The gateway adapter is a **consumer** of the bot API, not its owner. The bot API continues to serve multiple consumers:
- `agent_loop.py` — for embodiment/autonomy (coexists with gateway; both may respond to chat)
- `DaemonCraftAdapter` — for social/messaging
- `dashboard.html` — for debug UI and TTS playback

---

## Component Design

### 1. DaemonCraft Platform Adapter (`gateway/platforms/daemoncraft.py`)

Inherits from `BasePlatformAdapter`. Operates as a **read-only inbound adapter + outbound sender**.

#### Inbound: WebSocket from Bot API

- `connect()` — opens WebSocket `/ws` to `server.js`
- Listens for `type:chat` events from the bot
- `disconnect()` — closes WebSocket

**Event shape (CORRECTED from v2):**

`server.js` broadcasts a **snapshot array**, not a single event:
```js
ws.send(JSON.stringify({ type: 'chat', data: chatLog.slice(-30) }));
```

The adapter must implement the same time-filtering logic as `agent_loop.py:305-315`:
```python
# In WebSocket handler
import time

payload = json.loads(ws_message)
if payload["type"] == "chat":
    messages = payload["data"]  # array of last 30 chat entries
    new_messages = [m for m in messages if m.get("time", 0) > self._last_seen_timestamp]
    for m in new_messages:
        self._handle_chat_entry(m)
    if new_messages:
        self._last_seen_timestamp = max(m.get("time", 0) for m in new_messages)
```

**Initialization:** `_last_seen_timestamp` must be set to `int(time.time() * 1000)` in `connect()` before the first WebSocket message arrives. If initialized to `0`, the adapter will reprocess all 30 historical entries on first connect.

Each chat entry has this shape (existing `server.js` format, with proposed additions). **Note:** exactly one of `whisper` or `private` is present per entry; the other is `undefined`.

**Whisper entry (`/msg`, `/tell`):**
```json
{
  "type": "chat",
  "message": "hello pamplinas",
  "from": "NicoElViejoGamer",
  "uuid": "...",
  "whisper": true,
  "world": "world_nether",
  "time": 1714440000123
}
```

**Broadcast entry (public chat):**
```json
{
  "type": "chat",
  "message": "hello everyone",
  "from": "NicoElViejoGamer",
  "uuid": "...",
  "private": false,
  "world": "world_nether",
  "time": 1714440000456
}
```

**Field name notes (CRITICAL — do not change):**
- `server.js` uses `from` (not `username`) for the sender name. `agent_loop.py` reads `m.get("from", "")`.
- `server.js` uses `time: Date.now()` (13-digit milliseconds, not `timestamp`). `agent_loop.py` reads `m.get("time", 0)`.
- `server.js` whisper entries use `whisper: true` (no `private` field).
- `server.js` broadcast entries use `private: !routing.isBroadcast` (no `whisper` field).
  - `private: true` → directed message (not a global broadcast)
  - `private: false` → global broadcast
- The adapter must treat `undefined` fields as falsy.

#### Session mapping (CORRECTED from v2)

- **Whispers (`whisper=true`)** → True 1:1 session
  - `chat_id = player_username`
  - `thread_id = None`
  - `is_group = False`
- **Directed messages (`private=true`, no `whisper`)** → 1:1 session (message directed at specific target(s), not global broadcast)
  - `chat_id = player_username`
  - `thread_id = None`
  - `is_group = False`
- **Broadcast chat (`private=false`, no `whisper`)** → Group session per world
  - `chat_id = world_name`
  - `thread_id = world_name`
  - `is_group = True`
  - **Requires:** `group_sessions_per_user: false` in the DaemonCraft profile's `config.yaml`, otherwise Hermes defaults to per-player sub-sessions.
  - All players in the same world share one session context.

**Classification logic:**
```python
is_whisper = entry.get("whisper", False)      # True for /msg, /tell
is_private = entry.get("private", False)       # True for directed, False for broadcast

if is_whisper or is_private:
    # 1:1 session
    chat_id = entry["from"]
    is_group = False
else:
    # Group session (broadcast)
    chat_id = entry.get("world", "world")
    is_group = True
```

**Routing implementation (CORRECTED from v2 — no string prefix matching):**
```python
async def send(self, chat_id: str, content: str, reply_to=None, metadata=None) -> SendResult:
    # Derive is_group from session metadata (matches BasePlatformAdapter signature)
    is_group = False
    if metadata and isinstance(metadata, dict):
        is_group = metadata.get("is_group", False)
    
    if is_group:
        # Broadcast to all players in that world
        await self._post("/chat/send", {"message": content, "target": "broadcast"})
    else:
        # Whisper to specific player
        await self._post("/chat/send", {"message": content, "target": chat_id, "whisper": True})
```

#### Outbound: Full Response, No Filtering

**CRITICAL REQUIREMENT:** The legacy "SAY:" filter in `agent_loop.py` is **removed**. When the gateway adapter sends a message to Minecraft, it sends the **complete response text** from the AIAgent. There is no truncation, no extraction of a "SAY:" prefix, no chat-length heuristic.

**Server-side chunking:** `server.js` handles message fragmentation via `chunkForMc` and `byteCap` for both broadcast and whisper paths. The gateway adapter sends the full text and trusts the bot API to split it into protocol-compliant fragments.

#### TTS / Voice Integration (CORRECTED from v2)

```python
async def send_voice(self, chat_id: str, audio_path: str, **kwargs) -> SendResult:
    """TTS audio delivery via dashboard."""
    # The adapter CANNOT emit WebSocket events to other clients directly.
    # Instead, it POSTs to a bot API endpoint that relays to all dashboards.
    await self._post("/tts/play", {"audio_url": audio_path, "chat_id": chat_id})
    # Also send the FULL text to Minecraft chat so players can read it
    text = kwargs.get("text", "[Voice message]")
    return await self.send(chat_id, text)
```

**TTS must play the FULL response text.** The audio generated by Hermes TTS middleware is the complete agent response. It is never truncated, filtered, or post-processed. What the user hears in the dashboard is exactly what the agent said in its `Response:` block.

#### Self-message filtering

```python
# In WebSocket handler
for entry in new_messages:
    if entry.get("from", "").lower() == self.config.bot_username.lower():
        continue  # Ignore own chat echoes
    self._handle_chat_entry(entry)
```

---

### 2. Bot API Changes (`agents/bot/server.js`)

**Changes required for the adapter to function correctly:**

1. **Add `uuid` field to chat log entries**
   - At every chat log push, include the player's UUID (`bot.players[username]?.uuid`)
   - This enables UUID-based authorization (usernames can change; UUIDs are stable)

2. **Add `world` field to chat log entries**
   - At every chat log push, include `bot.game.dimension` (e.g., `"minecraft:overworld"`)
   - This enables broadcast → group-session mapping by world

3. **Add `POST /tts/play` endpoint**
   - Accepts `{"audio_url": "...", "chat_id": "..."}`
   - Relays to all dashboard WebSocket clients via `broadcastDashboard('tts_play', payload)`
   - Does NOT play audio in Minecraft chat (impossible)

4. **Add `GET /agent/log` endpoint**
   - Returns recent agent turn logs (same data already POSTed by `agent_loop.py`)
   - Enables gateway adapter to query recent loop activity for context injection
   - Optional query params: `?limit=10&since=timestamp`

5. **Extend `POST /chat/send`**
   - Accept `target: "broadcast"` — sends as public chat
   - Accept `target: "<username>"` + `whisper: true` — sends `/tell <target> <message>`
   - The adapter clamps text to 500 chars before sending; `server.js` passes to `bot.chat()`

**No removals.** `agent_loop.py` continues using the same WebSocket and HTTP endpoints.

---

### 3. Agent Loop (`agents/agent_loop.py`) — Coordination Mode

**Does NOT disappear.** It handles:
- Idle heartbeat (30s)
- Quest engine (sensor polling, auto phase advancement)
- Daemon guardian (creative mode, effects)
- Autonomous behavior (mining, building, pathfinding)

**NEW: Coexistence with gateway adapter**

When the gateway adapter is active for a profile, `agent_loop.py` continues running its chat response path. Both the loop and the gateway may respond to the same player message, resulting in duplicate responses. This is a known coexistence issue that will be solved at the root cause (unified cognition or message deduplication), not by silencing the loop.

**Message partition strategy (current):**
- Gateway adapter handles player-sourced chat (whispers + broadcasts) via the Hermes AIAgent
- Agent loop handles non-player events (quest events, blueprint updates, idle turns, system events)
- Both may respond to chat; duplicates are visible until fixed properly

**Legacy "SAY:" filter REMOVED**

The inconsistent "SAY:" extraction filter is removed entirely. `agent_loop.py` no longer attempts to parse or filter response text for chat. If the loop sends chat (when gateway is not active), it sends the full response text, and `server.js` handles chunking.

**State sharing bridge (Phase 1)**

To mitigate split-brain cognition without unified `AIAgent` instances:
- `agent_loop.py` continues logging turns via `POST /agent/log`
- Gateway adapter queries `GET /agent/log` at the start of each new session turn
- Injects last N loop turns into the system prompt as `[Recent activity: ...]`
- This is a **one-way read-only channel**: loop → gateway
- The loop remains authoritative for Minecraft world state

---

### 4. Dashboard TTS Mode

New dashboard feature: **Voice Mode** (`/voice` toggle).

When enabled:
- All gateway-routed messages to the Minecraft platform trigger Hermes TTS generation
- The adapter POSTs to `/tts/play`; `server.js` relays `tts_play` events to all dashboard WebSocket clients
- Dashboard plays audio via `<audio>` element
- **The audio is the FULL agent response text**, not truncated or filtered
- The agent can also receive voice input in the future (mic loop → gateway)

This is the **voice embodiment cone** of the agent.

---

### 5. Multi-Agent Casts

Each bot is a separate Hermes profile. Each profile already has its own gateway process:
- Bot 1 (Steve) → Gateway profile `steve` → `Platform.DAEMONCRAFT` + bot API port 3002
- Bot 2 (Moss) → Gateway profile `moss` → `Platform.DAEMONCRAFT` + bot API port 3003
- Bot 3 (Flint) → Gateway profile `flint` → `Platform.DAEMONCRAFT` + bot API port 3004

Each adapter connects to a single bot API. The gateway-per-bot is **not overkill** — it is the existing architecture.

**Cross-bot coordination:** Bots communicate via Minecraft chat (broadcast or whispers). The gateway routes these as normal messages. The agent can also use the `send_message` tool to send cross-platform messages (e.g., Minecraft → Telegram).

---

## Integration Checklist (Revised v5)

| Step | Status | Notes |
|------|--------|-------|
| 1. Core Adapter | 📝 DESIGN | WebSocket inbound (array snapshot), HTTP outbound, whisper/group routing |
| 2. Platform Enum | 📝 DESIGN | `Platform.DAEMONCRAFT` |
| 3. Adapter Factory | 📝 DESIGN | Add to `_create_adapter()` |
| 4. Authorization | 📝 DESIGN | `DAEMONCRAFT_ALLOWED_USERS` by UUID (not username) |
| 5. Session Source | 📝 DESIGN | `chat_id=player` whisper/directed, `chat_id=world` broadcast. Requires `group_sessions_per_user: false` |
| 6. System Prompt | 📝 DESIGN | "You are embodied in Minecraft. Be concise." + recent activity from `/agent/log` |
| 7. Toolset | 📝 DESIGN | No new tools needed — adapter is messaging-only |
| 8. Cron Delivery | 📝 DESIGN | Route to bot API via adapter |
| 9. Send Message Tool | 📝 DESIGN | `daemoncraft` platform routing |
| 10. Cronjob Schema | 📝 DESIGN | Mention `daemoncraft` |
| 11. Channel Directory | 📝 DESIGN | Session-based (worlds + players) |
| 12. Status Display | 📝 DESIGN | Show bot online/offline, current world |
| 13. Setup Wizard | 📝 DESIGN | Custom flow: bot API URL, bot username, MC host |
| 14. Redaction | ✅ N/A | No PII |
| 15. Documentation | 📝 DESIGN | This doc + wiki page |
| 16. Tests | 📝 DESIGN | Mock WebSocket + HTTP server |
| 17. `get_connected_platforms()` | 📝 DESIGN | Add DAEMONCRAFT special case in `config.py` (like Signal's `extra.get("http_url")`) |

---

## Migration Path (Revised v3)

### Phase 1: Adapter Skeleton + Bot API Fixes (MVP)
1. Update `server.js`:
   - Add `world` field to chat log entries (`bot.game.dimension`)
   - Add `POST /tts/play` endpoint (relays to dashboards)
   - Add `GET /agent/log` endpoint
   - Extend `POST /chat/send` with `target` + `whisper` fields
2. Update `agent_loop.py`:
   - Remove "SAY:" filter entirely
   - Loop continues handling chat; gateway adapter handles player chat via Hermes AIAgent
   - Duplicate responses are a known coexistence issue to be solved at root cause
3. Create `gateway/platforms/daemoncraft.py`:
   - WebSocket connect to `/ws` with array-snapshot filtering
   - Whisper → 1:1 sessions, broadcast → group sessions
   - `send()` via HTTP POST, full text, no filtering
   - `send_voice()` via `POST /tts/play`
   - Self-message filtering
   - Query `GET /agent/log` for context injection
4. Add `Platform.DAEMONCRAFT` to `config.py` enum
5. Add DAEMONCRAFT special case to `get_connected_platforms()`
6. Add to adapter factory in `run.py`
7. Test: chat with bot via Minecraft, bot responds, no double responses

### Phase 2: TTS Integration
- Hermes TTS generates audio for full response text
- Adapter POSTs to `/tts/play`
- Dashboard plays audio via `<audio>` element
- Add `/voice` toggle to dashboard
- Test: bot speaks full responses through dashboard speakers

### Phase 3: Full Gateway Integration
- Add setup wizard support
- Add status display
- Add cron delivery
- Test: multi-agent cast with 4 bots, each with its own gateway adapter

### Phase 4: Unified Cognition (Future / Research)
- Investigate sharing `AIAgent` instance between gateway adapter and agent_loop
- Merge autonomy loop with gateway messaging into single agent process
- Only if Phase 1-3 prove valuable

---

## Open Questions (Revised v3)

1. **Bot API authentication:** Currently unauthenticated (localhost only). Add a simple Bearer token for defense-in-depth?
2. **Cross-world messaging:** If a player is in `world_nether` and messages the bot, should the response be sent only to that world?
3. **Dashboard ownership:** Does the dashboard remain a bot-specific debug UI, or does it become a generic "agent embodiment dashboard"?
4. **Agent log retention:** How many turns should `/agent/log` retain? Should it persist across restarts?

---

## Responses to Review #1 Concerns

| Concern | Response |
|---------|----------|
| "Gateway is purely event-driven, no idle turns" | **Correct, and that's fine.** The agent_loop handles autonomy. The gateway handles social routing. They coexist. |
| "Broadcast chat creates isolated sessions" | **Fixed:** Broadcasts are group sessions (`chat_id=world_name`), whispers are 1:1 (`chat_id=username`). `group_sessions_per_user: false` required. |
| "Multi-agent casts incompatible with gateway" | **Not true.** Each bot is a separate Hermes profile with its own gateway. Already running for Telegram. |
| "Background workers have no home" | **They stay in `agent_loop.py`.** The adapter does not try to absorb them. |
| "TTS is fantasy" | **TTS plays through the dashboard, not Minecraft chat.** Adapter POSTs to `/tts/play`; server.js relays to dashboards. |
| "Remove WebSocket" | **WebSocket is kept.** The adapter consumes the same `/ws` that `agent_loop.py` uses. |

## Responses to Review #2 Concerns (Claude Code)

| Concern | Response |
|---------|----------|
| "Double-response problem" | **Mitigation deferred.** Loop and gateway coexist; duplicates are visible until unified cognition is implemented. No env-var silencing. |
| "Event shape is array snapshot, not single event" | **Fixed.** Adapter implements high-water timestamp filtering identical to `agent_loop.py:305-315`. Design doc now shows correct schema. |
| "`is_whisper` vs `whisper`" | **Fixed.** Uses existing `whisper` field from `server.js`. |
| "`world` field missing" | **Fixed.** `server.js` change scoped: add `bot.game.dimension` to every chat log push. |
| "`send_voice()` mechanically impossible" | **Fixed.** Adapter POSTs to `POST /tts/play`; `server.js` relays via `broadcastDashboard()`. No direct WebSocket client-to-client injection. |
| "`get_connected_platforms()` needs special case" | **Fixed.** Added to checklist (Step 17). Will add DAEMONCRAFT check in `config.py` similar to Signal's `extra.get("http_url")`. |
| "Username-based auth is fragile" | **Fixed.** Authorization uses UUID, not username. |
| "`chat_id.startswith('world')` is fragile" | **Fixed.** `send()` uses `is_group` boolean from session metadata, not string prefix matching. |
| "Split-brain cognition" | **Mitigated for Phase 1.** Gateway adapter queries `GET /agent/log` and injects recent loop activity into system prompt. One-way read-only channel. Unified cognition deferred to Phase 4. |
| "Full response must reach chat" | **Fixed.** Legacy "SAY:" filter removed. Adapter sends complete response text; `server.js` handles chunking. |

---

## References

- `~/Projects/hermes-agent/gateway/platforms/ADDING_A_PLATFORM.md`
- `~/Projects/hermes-agent/gateway/platforms/base.py`
- `~/Projects/hermes-agent/gateway/platforms/api_server.py`
- `~/Projects/hermes-agent/gateway/run.py`
- `~/Projects/hermes-agent/gateway/config.py`
- `~/Projects/DaemonCraft/MEMORY.md`
- `~/Projects/DaemonCraft/agents/agent_loop.py`
- `~/Projects/DaemonCraft/agents/bot/server.js`

## Responses to Review #3 Concerns (Claude Code — Round 2)

| Concern | Response |
|---------|----------|
| `m["timestamp"]` → `m["time"]` | **Fixed.** Pseudocode and schema now use `time`, matching `server.js` (`Date.now()`) and `agent_loop.py` (`m.get("time", 0)`). |
| `entry.get("username")` → `entry.get("from")` | **Fixed.** Self-message filter and schema now use `from`, matching `server.js` and `agent_loop.py`. |
| Schema shows `"username"` → should be `"from"` | **Fixed.** Schema corrected. |
| `whisper` vs `private` field ambiguity | **Fixed.** Session mapping rewritten: `whisper=true` OR `private=true` → 1:1 session; `private=false` (broadcast) → group session. Classification logic is explicit in the adapter pseudocode. |
| UUID not in chat log entries | **Fixed.** Added to `server.js` change list (Step 1). `uuid` field included in schema. |
| `_send_chat_chunks` attribution and behavior | **Fixed.** Clarified that `_send_chat_chunks` lives in `agent_loop.py` (Python), not `server.js`, and it **rejects** long lines. Added hard ceiling (500 chars) + truncation at adapter layer. TTS receives full unclamped text. |
| No chat length ceiling at adapter layer | **Fixed.** Hard ceiling of 500 chars with clean sentence-boundary truncation + `"[...]"` suffix. |

## Responses to Review #4 Concerns (Opus — Round 3)

| Concern | Response |
|---------|----------|
| `whisper`/`private` truth values inverted in v4 | **Fixed.** Session mapping rewritten. `private: true` → directed → 1:1. `private: false` → broadcast → group. `whisper: true` → true whisper → 1:1. Classification logic now explicit. |
| Schema shows `whisper` and `private` together | **Fixed.** Two separate schema examples: whisper entry (has `whisper`, no `private`) and broadcast entry (has `private`, no `whisper`). |
| Schema uses 10-digit seconds for `time` | **Fixed.** Examples use 13-digit milliseconds (`1714440000123`), matching `Date.now()`. |
| `_last_seen_timestamp` initial value unspecified | **Fixed.** Documented: must be initialized to `int(time.time() * 1000)` in `connect()`. |
| `send()` signature mismatch with `base.py` | **Fixed.** Signature now matches `BasePlatformAdapter`: `send(self, chat_id, content, reply_to=None, metadata=None)`. `is_group` derived from `metadata` dict. |
| `m["time"]` may raise `KeyError` | **Fixed.** Pseudocode uses `m.get("time", 0)` consistently. |
| `DISABLE_LOOP_CHAT_RESPONSE` failure mode undocumented | **Fixed.** Added failure mode warning with three mitigation strategies (systemd restart, watchdog, dependency). |

---

*End of v5 design. Seeking final sign-off before Phase 1 implementation.*
