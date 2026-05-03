# DaemonCraft Bedrock Pack (`.mcpack`)

Minimum-viable visual layer for Bedrock (tablet/console) players via Geyser
pack delivery. Covers DC-129. Parity with Java is intentionally NOT a goal
— tablet kids prioritize playing with friends over pixel-perfect parity.

## What's here

- `manifest.json` — Bedrock RP manifest (`format_version: 2`). UUIDs are
  stable; bumping pack content bumps the `version` array.
- `texts/en_US.lang` — pack name + description (referenced from manifest).
- `pack_icon.png` — placeholder 256×256 brand color. Replace with project
  art before public release.
- `textures/blocks/` — empty. Drop block-texture overrides here as they're
  authored.

## What's NOT here yet

The "minimum viable" is the manifest + branding so the pack delivers and
applies cleanly. Actual texture overrides need designed assets:

- Glass remap (mirror Clean Glass on Bedrock).
- Leaf textures matching Better Leaves silhouettes.
- Optional: branded loading screen overlay.

These slots stay empty until the assets land. The pack is still useful
once delivered: it confirms Geyser pack-delivery works end-to-end, and
gives Bedrock players a recognisable name in their resource pack list.

## Build

```bash
scripts/build-mcpack.sh
# → dist/daemoncraft-bedrock-<version>.mcpack
```

The `.mcpack` is just a renamed zip of this directory. Drop the result
into `server/geyser/packs/` and Geyser auto-serves it to connecting
Bedrock clients.

## Verify on real device

Per the plan:

1. Android tablet (Bedrock from Play Store) + Windows 10 Bedrock — most
   common kid devices.
2. Connect to `localhost:19132` (or the VPN address for remote).
3. Expect: pack downloads in the lobby, applies without prompts, name
   appears in `Settings → Global Resources`.

## Format notes

- `min_engine_version: [1, 21, 0]` — covers all Bedrock 1.21.x. If a
  Bedrock client older than that connects, the pack is rejected silently
  by the engine (player sees stock textures). Adjust if support for
  older versions is needed.
- `format_version: 2` is current as of 2026-05-03 and required for
  modern UUID + module structure.
- Pack size budget: keep ≤10 MB. Larger packs cause join-timeout on slow
  connections (open question in `plans/DC-129.md`).
