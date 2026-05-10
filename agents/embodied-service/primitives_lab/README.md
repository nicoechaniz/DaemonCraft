# Primitives Lab — Hermes ↔ Gemma-Andy coordination test bed

A controlled test surface for iterating on the primitives that flow
between Hermes (cloud LLM, persona+strategy) and Gemma-Andy (local LLM,
body decomposer). See `vault/concepts/two-agent-coordination-primitives.md`
for the architectural framing.

## Why

The 2026-05-09 field-test validated the basic loop. Now we want to
*systematically improve* the primitives — intent shape, allowed_tools
scope, guardian constraints, recovery feedback, etc. — without putting
Fede in the middle of every iteration.

The lab gives us:
- Controlled fixtures (known starting world_state, inventory, position)
- Variant primitives per experiment (vary intent, vary tool palette, ...)
- Quantitative metrics (success rate, latency, tool_call count, mitigation rate)
- Reproducible YAML specs that the Hermes AutoResearcher can drive

## Layout

```
primitives_lab/
├── README.md                 — this file
├── runner.py                 — single-experiment executor
├── ladder.py                 — multi-experiment coordinator
├── fixtures/                 — JSON snapshots of starting world_state
├── experiments/              — YAML specs (variants + expectations)
└── results/                  — timestamped run outputs
```

## Quickstart

Single run:

```bash
python primitives_lab/runner.py experiments/001_intent_verbosity.yaml
```

Ladder of all experiments:

```bash
python primitives_lab/ladder.py experiments/
```

AutoResearcher driven (TBD):

```bash
hermes research run --case embodied-primitives.yaml --rounds 3
```

## Experiment YAML spec

```yaml
id: 001-intent-verbosity
hypothesis: "Verbose intents reduce tool fabrication and improve plan quality"
fixture: forest_with_player.json
variants:
  - id: terse
    primitives:
      intent: "ven aca"
  - id: medium
    primitives:
      intent: "vení a la posición del jugador"
  - id: verbose
    primitives:
      intent: "Find and approach the player named {{player_name}} at their current position. Stop within 3 blocks. Avoid hazards along the way."
samples_per_variant: 5
expectations:
  must_invoke_embodied_plan: true
  tool_calls_must_include_any_of: [goto, follow]
  tool_calls_must_not_include: [mine_block, place_block, toss_item]
  max_elapsed_seconds: 30
  no_mitigations: true
metrics_to_capture:
  - success_rate
  - latency_p50
  - tool_call_count
  - mitigation_rate
  - tool_calls_emitted
```

## Metric definitions

- **success_rate** — fraction of samples where ALL expectations pass
- **latency_p50/p95** — embodied service `elapsed_seconds`
- **tool_call_count** — distribution of `len(plan.tool_calls)`
- **mitigation_rate** — fraction triggering consumer-side mitigation
- **tool_calls_emitted** — frequency table of tool names across samples
- **chat_quality** (heuristic, optional) — language match, brevity, on-topic

## Adding a fixture

1. Set up the bot in the desired starting world_state.
2. `curl http://localhost:7790/health` (verify service)
3. Capture: `curl http://localhost:3001/status`, `/nearby?radius=64`, `/inventory`
4. Compose into a JSON file matching the canonical 17-field shape from
   `vault/raw/gemma-andy/eval_with_adapter.py:EXAMPLE_USER.world_state`.
5. Save to `fixtures/<name>.json`.

The lab won't try to MUTATE the world to match the fixture — fixtures
describe the world the bot is *currently* in. To get reproducible
fixtures, use a known seed or a separate test world.

## Adding an experiment

1. Pick a primitive surface (intent shape, allowed_tools, guardian, etc.).
2. Write a hypothesis you can falsify.
3. Define 2-4 variants that vary that primitive.
4. Define expectations (must/must-not patterns over the response).
5. Save to `experiments/<NNN>_<name>.yaml`.
6. Run `runner.py` to validate the spec parses.
7. Run the ladder to get statistics.
8. Promote findings to `vault/concepts/` as a lesson page.
