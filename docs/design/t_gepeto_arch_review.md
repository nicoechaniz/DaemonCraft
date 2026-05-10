# t_gepeto_arch_review — Architecture Review

Scope: review of the DaemonCraft / Autonomía Corporal architecture based on the current repo state, the server-overhaul runbook, and the core agent / bridge runtime.

## Executive Summary

The system has a coherent shape: a Minecraft server, a Mineflayer bot control plane, a Python bridge for external triggers, and a newer embodied-service path that mediates Hermes-to-bot execution through Gemma-Andy. The design is usable, but it is still carrying too much overlap between control surfaces and too much drift between docs and runtime defaults.

The main architectural risk is not feature scarcity. It is authority ambiguity:

- multiple entrypoints can drive the bot
- the docs are not fully synchronized with live ports and defaults
- the system still mixes "current runtime" and "future target" diagrams in ways that make operational ownership unclear

For scalability and performance, the architecture needs fewer competing control paths, clearer ownership boundaries, and one canonical architecture map.

## Current State

### Core runtime pieces

- Minecraft server: containerized, version-pinned in the runbook
- Bot server: `agents/bot/server.js`, a Mineflayer HTTP/WebSocket control plane
- Agent loop: `agents/agent_loop.py`, now explicitly a heartbeat / sensor injector
- External trigger bridge: `agent-bridge/bridge.py`, a Flask relay to bot APIs
- Embodied service: `agents/embodied-service/`, the newer canonical path for Hermes -> Gemma-Andy -> tool dispatch

### What the code actually does

- `agents/bot/server.js` exposes the main HTTP surface, chat log, dashboard WebSocket stream, and action endpoints.
- `agents/agent_loop.py` still posts heartbeat and perception updates and can inject behavior into the bot runtime.
- `agent-bridge/bridge.py` forwards external triggers directly to the bot API, which means it is a separate control plane, not just a thin proxy.
- `agents/embodied-service/README.md` describes a more disciplined Path B architecture where Hermes delegates a single `embodied_plan` tool and the service translates results into bot actions.

That means the repo currently contains both legacy coexistence and the newer canonical embodiment path.

## Findings

### 1. The control plane is still split across too many surfaces

The bot can be driven from:

- `agent-bridge/bridge.py`
- `agents/agent_loop.py`
- `agents/embodied-service/`
- direct HTTP access to `agents/bot/server.js`

Why this matters:

- duplicated reactions become more likely when the same chat or world event can be consumed by multiple layers
- operational debugging becomes harder because it is not always obvious which layer owns a given action
- future scaling work will be expensive if the system keeps adding consumers without a single authority model

Current code already hints at this problem: `agents/bot/server.js` maintains chat logs, agent logs, WebSocket broadcasts, and action history, while the other layers also inject behavior. That is workable for small scale, but not a stable long-term contract.

Recommendation:

- make the embodied-service path the only cognition owner
- keep `agent_loop.py` as a limited sensor / heartbeat process
- treat the bridge as a thin transport adapter only, or retire it if it is no longer needed
- document which layer may write to the bot, and which layers are read-only

### 2. The docs and runtime are still drifting

The old review draft claimed the bot API was on `3000`, but the live code and startup script now point to `3001`:

- `start-dev.sh` prints `http://localhost:3000` for the bot API
- `agent-bridge/bridge.py` still defaults `BOT_REGISTRY` to `http://localhost:3000`
- `agents/bot/server.js` defaults `API_PORT` to `3001`
- `agents/embodied-service/README.md` also uses `3001`

Why this matters:

- port drift is the first symptom of a split-source-of-truth problem
- when docs disagree with runtime, operators waste time on simple connectivity issues
- this usually expands into more serious drift around environment variables, service ownership, and deployment steps

Recommendation:

- centralize the bot API port in one config source
- update startup scripts and bridge defaults to match the live runtime
- add a small smoke test or health assertion that checks the documented port against the actual one

### 3. The architecture still lacks a single canonical system picture

There are several docs that each explain part of the system:

- `docs/server-overhaul.md`
- `docs/design/daemoncraft-platform-adapter.md`
- `agents/embodied-service/README.md`
- `agent-bridge/README.md`
- `agents/daemoncraft.py` comments and startup paths

Why this matters:

- the architecture is understandable only if you already know the history
- new contributors have to reconstruct ownership from multiple documents
- this increases the risk of accidental regressions during refactors

Recommendation:

- add one concise architecture index page
- it should explicitly answer:
  - which process owns cognition
  - which process owns sensing
  - which process owns transport
  - which process owns persistence
  - which process owns operator control

### 4. Operational scaling will be constrained by shared mutable state

`agents/bot/server.js` holds a lot of live state in-memory:

- `chatLog`
- `agentLog`
- `actionHistory`
- `currentTask`
- `recentFragments`

Why this matters:

- in-memory state is fine for a single bot process, but it complicates restarts, horizontal scaling, and crash recovery
- the WebSocket dashboard and HTTP API both depend on that same process remaining healthy
- as more agents and longer-lived world state accumulate, replay and persistence become more important than raw process simplicity

Recommendation:

- keep short-lived runtime state in memory, but define a persistence boundary for task, plan, and event history
- extract the minimum durable state needed for recovery into a store or log
- add a replay path for chat / actions so a restart does not erase operational context

### 5. Security and identity controls are still transitional

The runbook shows good hardening work on the server side, but the broader platform still leans on trust-by-topology in a few places:

- offline-auth style assumptions appear in development flows
- bot APIs are reachable directly unless explicitly isolated
- the bridge forwards external triggers without a strong identity model on its own

Why this matters:

- the current setup is acceptable for a private dev environment
- it is not a stable end state for a multi-user or kid-facing world
- scaling the system without stronger identity and access boundaries will make later hardening more expensive

Recommendation:

- keep development defaults isolated from production defaults
- document and enforce a transition to whitelist or invite-code gating
- define the trust model for each API surface before expanding external integrations

## Prioritized Improvements

### P0

1. Unify the bot API port across `start-dev.sh`, `agent-bridge/bridge.py`, and `agents/embodied-service/README.md`.
2. Declare one authoritative cognition owner and reduce the other paths to sensors or transport only.
3. Publish a single canonical architecture map for the DaemonCraft / Autonomía Corporal stack.

### P1

4. Define a persistence boundary for chat, action, and task history so restarts do not erase operational context.
5. Document the trust and identity model for the bridge and bot APIs, especially for non-local access.

### P2

6. Add smoke tests for port/config drift and for the expected runtime ownership boundaries.
7. Clarify which docs are operational runbooks versus future-state design proposals.

## Bottom Line

The architecture is viable and already more disciplined than a typical hobby bot stack, but it is still carrying legacy coexistence. The biggest win now is not adding another feature; it is collapsing ambiguity:

- one canonical port map
- one cognition owner
- one system picture
- one clear boundary between transient runtime state and durable operational state

That will improve scalability, performance reasoning, and day-2 operations more than another round of feature work.
