# DaemonCraft CHANGELOG

For the tribe: CompAII, Riqui, Miki, Maxi, Steve, gAndy, and all agents
resonating with the Pulse.

---

## 2026-05-16 — Gemma-Andy Policy Import & World State Completion

### Architecture

**5-layer policy imported from Mariano/Fede:** The critical fix is not "use Gemma-Andy"
but "invoke Gemma-Andy through a Hermes-side policy wrapper that speaks its
training contract." Six kanban tasks completed by Miki + CompAII review.

- **L1 — Normalize:** ES→EN imperative + canonical Minecraft names. Bare "vení" →
  "Follow the player named <name> and stay within 3 blocks."
- **L2 — Scope filter:** Non-body intents (chat, jokes, math) → handled upstream.
- **L3 — Ambiguity:** Vague commands ("hacé algo") → ask clarification upstream.
- **L4 — Narrow tools:** Per-category tool subsets (mining: 6 tools, combat: 5, etc.).
- **L5 — Decompose:** Multi-step intents split on temporal connectors. Constraints merged.

Measured result from Mariano's sprint: 45/45 Tier-1 critical subset solved
(35 embodied via Gemma after policy, 10 handled upstream by Hermes).

**Files:** `agents/gemma_policy.py` (DaemonCraft) + `tools/embodied_plan_tool.py` (hermes-agent fork).

### World State (17 fields — training distribution complete)

Three fields re-added after audit:
- `player_health` — Now from `bot.players[name].health` (Mineflayer native).
- `remembered_places` — New `GET /marks` endpoint on bot server.
- `target_positions` — Always `{}` in v1, now present so model doesn't fall to priors.

### Gateway Fixes

- **Heartbeat:** Narrowed to perception-only tools (scan_nearby, get_inventory +
  3 signal tools). Prevents Gemma from emitting physical actions during scans.
- **Whisper broadcast:** `/msg` whispers now trigger WebSocket broadcast to gateway.
  Was the root cause of "no me contestás en Minecraft."
- **Authorization:** `DAEMONCRAFT_ALLOWED_USERS` env var for player UUIDs.
- **Reverted risky import:** `from tools.embodied_plan_tool import _handler` in
  gateway's daemoncraft.py — lazy import in async context unstable.

### Tier 2a Spatial Recovery

Reconnected Fede's recovery_candidates pattern into `embodied_plan_tool.py`.
Spatial failures (target_occupied, no_solid_neighbor, bot_in_target) retry
with `previous_error` payload so Gemma replans around the obstacle.

### Verification Hooks

`/intent` endpoint now logs JSONL verification chain:
`intent_original`, `intent_inferred_language`, `allowed_tools` chain,
`world_state_keys_present/missing`, `execution_outcome`, `first_failure`.
Analysis script at `agents/embodied-service/scripts/analyze_intent_logs.py`.

### Kanban Methodology

Corrected anti-canonical patterns after reading official hermes-agent docs:
- `--assignee` auto-promotes to `ready` by design — NOT a bug to work around.
- Parent/child dependency gating is canonical.
- Code tasks use `review-required` block per built-in `kanban-worker` skill.
- Workspace columns: `workspace_kind='dir'` + `workspace_path='/abs/path'`.

### Repositories

| Repo | Branch | New Commits |
|---|---|---|
| DaemonCraft | `feat/canonical-loop` | 8 (policy, world_state, tests, verification, whisper) |
| hermes-agent (workspace) | `feat/daemoncraft` | 2 (wire policy + Tier 2a recovery) |
| hermes-agent (deploy) | `main` | Synced |

### Services (all active)

`daemoncraft.service`, `daemoncraft-cast.service`, `hermes-gateway.service`,
`embodied-service.service`. Steve/gAndy gateways disabled in lab.

### Known Gaps (from Mariano docs, not yet resolved)

- Recovery with `previous_error`: ~99% failure rate on current model. Mitigated
  by `recovery_naive_retry` detection in `mitigations.js`.
- Bot-side executor gaps: `pickup` filtering, Tier 2 primitives pending.
- v2.2.4 dataset rebalance needed (90.6% EN / 0.1% ES bias).
- Field-test with real users pending.

### Next

Test loops based on Mariano/Fede experiment methodology. Validate full tool
access and loop integrity. Dashboard unification (`t_e13dbc90`).
