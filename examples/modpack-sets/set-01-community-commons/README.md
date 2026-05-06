# Set 01: Community Commons

**Philosophy:** Zero-cost, zero-commission, zero-AI. Every asset comes from a
permissive CC license. Ideal for public servers where you want no legal friction
and full redistribution freedom.

**Sourcing path:** Path 1 only (adapt existing CC-BY / CC0 packs)

**Budget:** $0

---

## What's inside

| Slot | Source | License |
|---|---|---|
| Java Better Leaves | Motschen's Better Leaves | CC-BY-SA-4.0 |
| Java Clear Glass | LollikiLP's Clear Glass | CC-BY-NC-SA-4.0 |
| Java UI font | Default (vanilla) | N/A |
| Bedrock leaves | Adapted from Java Better Leaves | CC-BY-SA-4.0 |
| Bedrock glass | Adapted from Java Clear Glass | CC-BY-NC-SA-4.0 |
| pack_icon.png | CC0 pixel-art placeholder from OpenGameArt | CC0 |

**Note:** Clear Glass is CC-BY-NC-SA (non-commercial). If DaemonCraft ever
monetizes, swap this asset for a CC-BY or CC0 alternative before going live.

---

## Build order

1. Drop real `.png` assets into `java-rp/assets/minecraft/textures/...`
2. Build `daemoncraft-server.zip` from `java-rp/`
3. Adapt/copy textures to `bedrock-mcpack/textures/blocks/`
4. Run `scripts/generate-sha1.sh` to pin server.properties
5. Copy `.mcpack` into Geyser's `packs/` folder
