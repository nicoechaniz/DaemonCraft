# DaemonCraft Embodied Service v1

The Path B canonical bridge between **Hermes** (cloud LLM cognition) and
**Gemma-Andy** (Gemma-4 E4B fine-tune served by Ollama on inference01).
Hermes calls one tool — `embodied_plan(intent, ...)` — and this service
handles the rest:

```
Hermes ── HTTP intent ──▶ embodied-service ── /api/chat ──▶ Ollama (Gemma-Andy)
                                │
                                │ HTTP per tool_call (translated)
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
roadmap. Lattice: HRM-128 (T002.11).

---

## Status (2026-05-09)

**v1 functional, field-test gate not yet passed.**

What works end-to-end (validated against AlterCraft + live Gemma-Andy):

- Hermes calls `embodied_plan` → service composes canonical Gemma-Andy
  v2 payload → Ollama → parsed plan → tool_calls dispatched to bot →
  real-world side effects (e.g. "Mine 2 oak logs" → 2 oak_log in
  bot inventory in 14s).
- Canonical schema from `Mar-IA-no/deamoncraft-gemma4-andy` (blob
  `5896efa3`) shipped at `lib/tool_schema_v2.json` — 68 tools / 42
  executor-supported (1 consumer override: `build_blueprint`).
- Translator dispatcher resolves canonical refs (BlockType, EntityRef,
  Position3D, PlaceName) into the coord-pure args bot/server.js
  expects, via `find_blocks` / `find_entities` / `marks` lookups.

What does NOT work yet — **gating signal for the field-test gate
(E002 Phase 7)**:

- 5 reference cases from the integration guide: 3/5 pass.
  - ✓ positive, ambiguous, unsafe
  - ✗ recovery (3/3 retries: model ignores `previous_error`)
  - ✗ out_of_scope (2/3 silent `tool_calls: []`, 1/3 in-game treatment)
- These are reproducible **model regressions** vs the integration
  guide's promised behavior, not wireup failures. See `test/reference_cases.test.js`.

Recommendation: surface to Mariano (training team) before declaring
`gemma-andy:e4b-v2-2-3-q8_0` the production target.

---

## Run

Local development (assumes the bot is up at `localhost:3001` and
Gemma-Andy is reachable at `inference01:11434`):

```bash
cd agents/embodied-service
npm install
node index.js
```

Or via npm: `npm start`.

The service listens on **port 7790** by default.

### Environment variables

| Var | Default | Purpose |
|---|---|---|
| `EMBODIED_SERVICE_PORT` | `7790` | Port to bind |
| `BOT_API_URL` | `http://localhost:3001` | Where bot/server.js is reachable |
| `OLLAMA_URL` | `http://10.10.20.1:11434` | Ollama HTTP endpoint |
| `GEMMA_ANDY_MODEL` | `gemma-andy:e4b-v2-2-3-q8_0` | Tag served by Ollama |
| `SCHEMA_PATH` | `lib/tool_schema_v2.json` | Override to test a different schema version |

### Bot setup (one-time per session)

The bot is a Mineflayer client. Point it at the MC server:

```bash
cd agents/bot
MC_HOST=10.10.20.1 MC_PORT=25565 MC_USERNAME=HermesBot MC_AUTH=offline node server.js
```

Verified to work against AlterCraft (Paper 1.21.11, protocol 774,
inference01:25565). Server-agnostic in design — DaemonCraft (Purpur
1.21.11) works identically once the bot connects.

---

## API

### `GET /health`

```json
{
  "ok": true,
  "service": "daemoncraft-embodied-service",
  "version": "0.1.0",
  "port": 7790,
  "ollama_url": "http://10.10.20.1:11434",
  "model": "gemma-andy:e4b-v2-2-3-q8_0",
  "schema_version": "gemma-andy-tools-v2",
  "schema_total": 68,
  "schema_supported": 42
}
```

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

---

## The 6 hard rules

These are non-negotiable and live in code:

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

---

## Architecture notes

### Translator dispatcher (`lib/dispatcher.js` + `lib/refs.js`)

The bot's ACTIONS table is coord-pure — `goto({x, y, z})`,
`dig({x, y, z})`, `place({block, x, y, z})`. Canonical Gemma-Andy v2
emits semantic refs — `goto({target: "oak_log", target_type: "block"})`,
etc. The dispatcher is a real translator:

1. Receives a canonical tool_call from the parsed Gemma-Andy response.
2. Resolves any reference args via `lib/refs.js` (calls
   `find_blocks` / `find_entities` / `marks` on the bot, picks nearest).
3. Maps the canonical tool name to the bot's action name (e.g.
   `mine_block` → `collect`, `consume_food` → `eat`,
   `place_block` → `place`).
4. POSTs `/action/<name>` with the translated body.

Signal tools (`ask_clarification`, `raise_guardian_event`,
`report_execution_error`) bypass the bot — they're consumer-side
signals returned to Hermes verbatim.

### Schema as source of truth

The canonical schema lives at `lib/tool_schema_v2.json`, fetched from
`Mar-IA-no/deamoncraft-gemma4-andy:schema/tool_schema_v2.json`.
Provenance (URL, fetched_at, blob_sha) is recorded in `_meta`.

When a canonical flag must be overridden for our specific bot (e.g.
`build_blueprint` is canonical-supported but our bot has no
block-placement blueprint executor), the override is recorded in
`_meta.consumer_overrides` with date and reason.

### When to add a new bot endpoint

1. Implement the endpoint in `agents/bot/server.js` ACTIONS table
2. Add a canonical → bot mapping in `lib/dispatcher.js` HANDLERS
3. If the canonical tool was `executor_supported: false`, flip it to
   `true` (or remove from `consumer_overrides` if previously overridden)
4. Restart the service

Tests catch the schema-vs-handler drift: every supported canonical tool
must have a HANDLERS entry.

---

## Tests

```bash
# Pure unit tests (no network, no live model):
node --test test/parser.test.js test/schema.test.js test/ollama.test.js test/dispatcher.test.js
# 31/31 pass

# Live reference-case tests (requires Ollama + Gemma-Andy reachable):
LIVE_OLLAMA_TESTS=1 node --test --test-timeout=120000 test/reference_cases.test.js
# 3/5 pass — see Status section above
```

---

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

---

## Path 0 vs Path B — when to use which

There used to be a third path on the Hermes side: a 70-tool `altercraft`
toolset (`tools/altercraft_tool.py` in `hermes-agent`, retired
2026-05-09 — see `legacy/altercraft-toolsets` branch in
`Fede654/hermes-agent`) that wrapped each bot ACTION as a Hermes tool
directly.

**Decision (2026-05-09):** retired in favor of Path B for all
DaemonCraft profiles.

| Concern | Path 0 (retired) | Path B (canonical) |
|---|---|---|
| Tools on Hermes' side | 70 `altercraft_*` tools | 1 `embodied_plan` tool |
| Body micro-planning | Hermes (expensive cloud LLM) | Gemma-Andy (4B local) |
| Token cost per body action | High (Hermes plans every step) | Low (Gemma-Andy plans, Hermes delegates) |
| Guardrails enforcement | Per-tool, scattered | Centralized in service |
| Adding a new tool | New file, registry, schema | Update `tool_schema_v2.json` + dispatcher |

If you find yourself needing direct bot access for a specific debugging
session, the bot's HTTP API at `/action/<name>` is still the same and
can be hit from `curl` without going through the embodied service.
