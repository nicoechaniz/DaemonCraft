# DaemonCraft

DaemonCraft is a multi-agent Minecraft environment where persistent AI companions inhabit Mineflayer bodies, perceive and act through Hermes Agent, and coordinate with an embodied planning service.

## Current architecture

- `server/` — Purpur Minecraft server data, plugins, and backups
- `agents/bot/` — Mineflayer body, HTTP/WebSocket API, movement, reflexes, and dashboards
- `agents/agent_loop.py` — body events, interoception, and gateway wake-up bridge
- `agents/embodied-service/` — bounded embodied intent planning and dispatch
- `agents/daemoncraft.py` — cast and bot lifecycle management
- `scripts/daemoncraft-ops.py` — status, health, controller-mode, and operational probes
- `docs/` — durable architecture, development, and operations documentation

DaemonCraft supports two deliberately separate modes:

- **lab** — interactive embodiment controlled from a Hermes client; no autonomous L4 turns
- **autonomous** — heartbeat-driven agent turns; enable only for bounded, observable experiments

## Project authority

- [GitHub Issues](https://github.com/nicoechaniz/DaemonCraft/issues) own actionable work, scope, dependencies, and acceptance criteria.
- Pull requests and commits carry implementation and verification evidence.
- `docs/` contains durable architecture and operational knowledge.
- `CHANGELOG.md` contains release history.
- `MEMORY.md`, `plans/`, Lattice snapshots, and the retired local Kanban are historical evidence, not live trackers.

See `AGENTS.md` for the contributor and automation contract.

## Operational safety

Do not start, restart, enable, or switch DaemonCraft services or autonomous mode without explicit maintainer instruction.

Read [`docs/OPERATIONS.md`](docs/OPERATIONS.md) before operating the stack. A safe read-only preflight is:

```bash
./scripts/daemoncraft-ops.py status
./scripts/daemoncraft-ops.py health
```

The current recovery work is tracked in:

- [#23 — Restore the known-good interactive lab embodiment baseline](https://github.com/nicoechaniz/DaemonCraft/issues/23)
- [#24 — Diagnose autonomous-mode context divergence and action thrash](https://github.com/nicoechaniz/DaemonCraft/issues/24)
- [#28 — Reconcile the runtime cognition contract](https://github.com/nicoechaniz/DaemonCraft/issues/28)

## Development

- Use feature branches and pull requests; never commit directly to `main`.
- Search GitHub Issues and existing PRs before creating work.
- Preserve unrelated dirty changes.
- Add focused regression tests and report the exact verification commands in the PR.
- Never commit credentials or private runtime data; this repository is public.
