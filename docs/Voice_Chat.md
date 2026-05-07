# Voice Chat

Web-based voice interface for talking to the DaemonCraft bot without typing.

## Quick Start

1. Open `http://<bot-server>:3001/voice` in a browser.
2. Set your Minecraft player name (default: `Player`).
3. Hold the mic button, speak in Spanish, release to send.
4. The bot receives your message as a player chat and the agent responds.

## Architecture

```
Browser (voice-chat.html)
       |
       | Web Speech API (STT)  +  WebSocket /ws
       | POST /chat/send { message, as: "PlayerName" }
       v
   Bot Server (server.js)
       |
       | /tellraw (when as != bot name)
       | WebSocket broadcast
       v
   Agent (agent_loop.py)
       |
       | Reads chat from WS stream
       v
   LLM decides action -> tool calls -> Minecraft
```

## Agent Integration

The voice UI does **not** require any changes to `agent_loop.py`. It reuses the existing chat pipeline through a small trick in `POST /chat/send`.

### The `as` field

When the voice UI sends:

```json
POST /chat/send
{
  "message": "recolecta madera",
  "as": "JereC4str0"
}
```

The bot server detects that `as` is present and different from the bot username. Instead of sending `bot.chat()` (which would make the message appear as coming from the bot itself), it injects the message via `/tellraw` with the player's name and broadcasts it through the WebSocket.

The agent's WebSocket listener receives:

```json
{
  "type": "chat",
  "data": [
    { "from": "JereC4str0", "message": "recolecta madera", "time": 1234567890 }
  ]
}
```

Because `from` is not the bot username, `agent_loop.py` treats it as a regular player message and triggers a turn.

### Why this matters

Without the `as` field, the voice message would be sent as `bot.chat(message)`. The bot server would broadcast it with `from: "HermesBot"`, and the agent filters out its own messages to avoid infinite loops. The agent would never see the voice input and would stay silent.

### Requirements

- Bot server must support `body.as` in `POST /chat/send` (already implemented).
- The player name in the voice UI must differ from the bot username.
- WebSocket connection must be active so the agent receives the broadcast.

## Browser Support

- **Chrome / Edge**: Full support (Web Speech API + WebSocket).
- **Firefox**: Speech recognition may require a polyfill or permission prompt.
- **Mobile Chrome**: Works with tap-and-hold on the mic button.

## Configuration

The HTML is self-contained and reads from input fields in real time (no hardcoded URLs cached on load):

| Field | Default | Purpose |
|---|---|---|
| API URL | `http://localhost:3001` | Bot server REST endpoint |
| WS URL | `ws://localhost:3001/ws` | Bot server WebSocket endpoint |
| Player Name | `Player` | Name shown to the agent and other players |

Changing any field reconnects the WebSocket automatically.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Agent ignores voice messages | Missing `as` field | Ensure Player Name != bot username |
| Duplicate messages in chat log | Client appending arrays blindly | UI clears and re-renders full history on each WS message |
| "Disconnected" status | Wrong port or bot server down | Check API/WS URL inputs |
| Mic not working | Browser blocking permissions | Allow microphone access in site settings |
