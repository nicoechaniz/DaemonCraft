# Profile templates for the embodied-service architecture

These are **reference copies** of the Hermes profile that consumes the
embodied service. The canonical files live at
`~/.hermes/profiles/daemoncraft-base/{config.yaml,SOUL.md}`. We mirror
them here so the architecture decision (Path B, embodied_plan as the
single body tool) is reviewable alongside the service code that depends
on it.

## Files

- `daemoncraft-base.config.yaml` — toolsets `[embodiment, messaging]`,
  model `kimi-k2.6` / provider `kimi-coding`. The metric of success for
  the 2026-05-09 refactor.

- `daemoncraft-base.SOUL.md` — the prompt that teaches the cloud LLM
  the new pattern: one tool (`embodied_plan`) for body, narrate the
  intent, parse the response, retry with `previous_error` on failure,
  confirm with the player on `operational_risk` >= high.

## Workflow

When you change the canonical profile in `~/.hermes/profiles/`:

1. Test that it loads: `python -c "import tools.embodied_plan_tool; from tools.registry import registry; print(registry.get_tool_names_for_toolset('embodiment'))"`
2. Copy the new content into this directory: `cp ~/.hermes/profiles/daemoncraft-base/{config.yaml,SOUL.md} agents/embodied-service/profile-templates/`
3. Commit both daemoncraft (mirror) and any profile-bootstrap script
   that creates the file in `~/.hermes/`.

## Backups

Pre-refactor versions are at `~/.hermes/profiles/daemoncraft-base/{config.yaml,SOUL.md}.pre-embodied-2026-05-09`.
