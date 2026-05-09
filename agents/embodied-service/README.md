# DaemonCraft Embodied Service v1

The Path B canonical bridge between **Hermes** (cloud LLM cognition) and
**Gemma-Andy** (Gemma-4 E4B fine-tune served by Ollama on inference01).
Hermes calls one tool — `embodied_plan(intent, ...)` — and this service
handles the rest:

```
Hermes ── HTTP intent ──▶ embodied-service ── /api/chat ──▶ Ollama (Gemma-Andy)
                                │
                                │ HTTP per tool_call
                                ▼
                          bot/server.js
                                │
                                ▼
                            Mineflayer
                                │
                                ▼
                            Minecraft
```

See `vault/concepts/gemma-andy-embodied-service.md` for the architectural
context and `vault/epics/E002-body-protocol-wireup.md` for the active
roadmap.

## Status

**v1, sprint 1-3 complete.** Skeleton + Ollama integration + tool
dispatcher in place. Schema is a placeholder pending Mariano's canonical
`tool_schema_v2.json`. Hermes-side tool registration is in
`hermes-agent/tools/embodied_plan_tool.py` (separate repo).

## Run

```bash
cd agents/embodied-service
node index.js
```

Or via npm: `npm start`.

The service listens on **port 7790** by default. Override with
`EMBODIED_SERVICE_PORT`.

### Environment variables

| Var | Default | Purpose |
|---|---|---|
| `EMBODIED_SERVICE_PORT` | `7790` | Port to bind |
| `BOT_API_URL` | `http://localhost:3001` | Where bot/server.js is reachable |
| `OLLAMA_URL` | `http://10.10.20.1:11434` | Ollama HTTP endpoint |
| `GEMMA_ANDY_MODEL` | `gemma-andy:e4b-v2-2-3-q8_0` | Tag served by Ollama |
| `SCHEMA_PATH` | `lib/tool_schema_v2.placeholder.json` | Override when canonical schema is shipped |

## API

### `GET /health`

Returns service version + Ollama target + schema metadata.

### `POST /intent`

Request body:

```jsonc
{
  "intent": "Help the player gather wood before night.",
  "autonomy_level": 2,
  "allowed_tools": null,             // null → service default safe set
  "guardian_constraints": null,      // null → DEFAULT_GUARDIAN_CONSTRAINTS
  "previous_error": null,            // or { tool, error_type, details }
  "deadline_seconds": 30
}
```

Response (200):

```jsonc
{
  "ok": true,
  "context_id": "uuid-...",
  "plan": {
    "body_plan": [...],
    "checks": [...],
    "tool_calls": [...],
    "failure_policy": "...",
    "operational_risk": "low"
  },
  "think": "<reasoning text>" | null,
  "execution_results": [
    {"tool": "scan_nearby", "ok": true, "data": {...}},
    {"tool": "mine_block", "ok": true, "data": {...}}
  ],
  "elapsed_seconds": 3.2,
  "model": "gemma-andy:e4b-v2-2-3-q8_0"
}
```

Error responses include `error: { error_type, details }` plus an
appropriate HTTP status code (400 client error, 502 upstream error,
500 handler bug).

## The 6 hard rules

These are non-negotiable and live in code (`lib/ollama.js`,
`lib/parser.js`):

1. **No system prompt in the request.** The Gemma-Andy Modelfile bakes
   the contract byte-exact with training (fix `7205b0a`, 2026-05-08).
2. **Canonical JSON serialization** matching Python's
   `json.dumps(payload, sort_keys=True, ensure_ascii=True)` — see
   `canonicalStringify` in `lib/ollama.js`.
3. **Only canonical v2 tool names** in `allowed_tools`. The schema
   filter is the gate.
4. **Only canonical `world_state` keys.** Non-canonical fields are
   silently ignored by the model.
5. **No sampling override.** Modelfile defaults are tuned for stable
   JSON output.
6. **Tolerant parser.** ~1% of outputs may have residual text around
   the JSON; the parser falls back to first-`{` to last-`}` extraction.

## Tools-not-implemented pattern

The schema flags 25 of 68 tools as `executor_supported: false`. Workflow
when adding an endpoint to `bot/server.js`:

1. Implement the endpoint
2. Add the canonical tool name → endpoint mapping in
   `lib/dispatcher.js` (`HANDLERS` table)
3. Flip `executor_supported: true` in `lib/tool_schema_v2.placeholder.json`
   (or in the canonical schema once Mariano ships it)
4. Restart the service

The model is not retrained, the prompt is not touched.

## Tests

```bash
node --test test/
```

Pure tests cover: parser (with/without `<think>`, bracket fallback,
required-field validation), schema (loading, filtering, supported set),
canonical stringifier (alphabetical keys, ASCII escaping, emoji
surrogate pairs), dispatcher (signal tool short-circuits,
tool_not_implemented gate, handler coverage of every supported tool).

End-to-end against live Ollama + live `bot/server.js` is covered by the
field session in E002 Phase 6 (not in `node --test`).

## Disciplina v1 — what NOT to add

- Persistent memory between intents
- Intent priority queue (FIFO via HTTP serialization is enough)
- Auto-initiative or autonomous hazard detection
- Clean cancellation of in-flight plans
- Progress estimation (`body.estimate_time_to`)
- Own Mineflayer session

These are v2+ territory. Per the team architectural decision
(2026-05-08): "Path B canonical, v1 minimal, capabilities only when
field signal demands them."
