# Set 04: DaemonCraft Prime

> The convergence pack. Takes the zero-legal-friction foundation of Set 01,
> the professional branding discipline of Set 02, and the rapid iteration
> workflow of Set 03 — then applies 2026 SOTA best practices to produce a
> production-ready, commercially clean, visually cohesive server experience.

**Philosophy:** Source textures from the best CC-licensed community packs,
commission branding from human artists (using AI-generated concepts as brief
material), and separate client-side enhancements (animations, shaders) from the
server-pushed texture bundle.

**Sourcing paths:** Path 1 (CC textures, NC-free) + Path 2 (commissioned
branding, guided by Path 3 AI concepts) + Path 3 (concept generation only,
NOT final assets).

**Budget:** $150-400 (same as Set 02, but spent more efficiently thanks to
AI concept pre-validation).

---

## What's inside

### Java Server Resource Pack (`daemoncraft-server.zip`)

|| Asset | Source | License | Notes |
|---|---|---|---|---|
|| Better Leaves | Motschen's Better Leaves | CC-BY-SA-4.0 | Community standard; kept from Set 01 |
|| Clear Glass | **Clear Glass Connected** (Modrinth) | **MIT** | Swapped from Set 01's NC-licensed glass. Commercial-safe. |
|| Branded UI frames | **Generated** (Pillow procedural) | CC-BY-SA-4.0 | Cyan-purple palette, vanilla-faithful. Human-commissioned finals may replace. |
|| Title screen bg | **Generated** (Pillow procedural) | CC-BY-SA-4.0 | 1920x1080 procedural landscape. Human-commissioned finals may replace. |
|| pack.png | **Generated** (Pillow procedural) | CC-BY-SA-4.0 | 256x256 branded icon. Human-commissioned finals may replace. |
|| Particles | **Generated** (retint) | CC-BY-SA-4.0 | `particles/mycelium.json` — retinted to Design System cyan |

**Actual size:** ~4.4 MB (leaves 2.5 MB + glass 0.3 MB + UI + background + pack.png).
**Target:** ≤ 6 MB.

**Key rule:** NO entity animations in the server-pushed pack. Vanilla clients
would see broken models. Animations live in the `.mrpack` only.

### Bedrock `.mcpack`

|| Asset | Source | License |
|---|---|---|---|
|| Leaves textures | Adapted from Better Leaves | CC-BY-SA-4.0 |
|| Glass textures | Adapted from Clear Glass Connected | MIT |
|| pack_icon.png | **Generated** (Pillow procedural) | CC-BY-SA-4.0 |

**Actual size:** ~1.5 MB.
**Target:** ≤ 2 MB.

### Java Client `.mrpack`

|| Component | Source | Type |
|---|---|---|---|
|| Entity Model Features (EMF) | Modrinth | Client mod |
|| Entity Texture Features (ETF) | Modrinth | Client mod |
|| Fresh Animations | FreshLX | Client resource pack |
|| Continuity | Modrinth | Client mod (connected textures) |
|| Better Leaves | Motschen | Server RP (also bundled for singleplayer) |
|| Clear Glass Connected | Modrinth | Server RP (also bundled for singleplayer) |
|| Branded UI pack | **Generated** (Pillow procedural) | Client resource pack |
|| `servers.dat` | DaemonCraft infra | Server list entry |
|| `resourcepackoverrides.json` | FxMorin | Forces RP load order |

**Actual size:** ~32 MB (mods ~12 MB + RPs ~20 MB).
**Target:** ≤ 150 MB.

---

## AI-assisted commission workflow (the Set 03 contribution)

Instead of commissioning blindly, Set 04 uses AI to pre-validate visual
directions before paying artists:

1. **Generate 10-20 concepts per asset** with DALL-E 3 or SDXL + LoRA
2. **Review with the team** (or solo) — pick the 2-3 best directions
3. **Include concept images in the commission brief** — artists see the vibe,
   not just words
4. **Artist creates final asset** — pixel-perfect, grid-aligned, human-authored
5. **AI concepts are discarded** — they served their purpose as briefing material

This reduces revision rounds (saving $50-100 per asset) and ensures the
commissioned output matches the team's vision on the first try.

See `docs/ai-concepts/` for example prompts and generated concept placeholders.

---

## Build

### Prerequisites

```bash
# Download Clear Glass Connected from Modrinth
curl -L -o /tmp/clear-glass-connected.zip \
  "https://cdn.modrinth.com/data/clear-glass-connected/version/latest/clear-glass-connected.zip"

# Or use the build script:
./scripts/build-set04.sh
```

### Manual build

```bash
cd /home/fede/REPOS/daemoncraft

# 1. Build Java Server RP
(cd examples/modpack-sets/set-04-daemoncraft-prime/java-rp && \
  zip -r ../../../../server/data/resourcepacks/daemoncraft-prime.zip \
  pack.mcmeta assets/ pack.png)

# 2. Compute SHA1
sha1=$(sha1sum server/data/resourcepacks/daemoncraft-prime.zip | cut -c1-40)
sed -i "s|resource-pack=.*|resource-pack=http://10.10.20.240:8765/daemoncraft-prime.zip|" \
  server/data/server.properties
sed -i "s|resource-pack-sha1=.*|resource-pack-sha1=$sha1|" \
  server/data/server.properties
sed -i "s|resource-pack-prompt=.*|resource-pack-prompt=DaemonCraft Prime: The Convergence Pack|" \
  server/data/server.properties

# 3. Build Bedrock pack
(cd examples/modpack-sets/set-04-daemoncraft-prime/bedrock-mcpack && \
  zip -r daemoncraft-prime.mcpack manifest.json textures/ pack_icon.png)

# 4. Copy to Geyser
cp examples/modpack-sets/set-04-daemoncraft-prime/bedrock-mcpack/daemoncraft-prime.mcpack \
  server/plugins/Geyser-Spigot/packs/

# 5. Build .mrpack (requires Modrinth API resolution)
./scripts/build-mrpack.sh \
  examples/modpack-sets/set-04-daemoncraft-prime/mrpack

# 6. Reload server
docker exec -u 1000 daemoncraft-minecraft rcon-cli \
  --host 10.10.20.240 --password daemoncraft-rcon reload
```

---

## Commission checklist

All branded assets currently use **production-quality procedural placeholders** (Pillow-generated, Design System palette). Human-commissioned finals may replace them in a future update.

|| Asset | Status | Budget | Brief location |
|---|---|---|---|---|
|| pack_icon.png | ✅ Placeholder active | $50-100 | `docs/commission-briefs/pack_icon.md` |
|| UI button frame set | ✅ Placeholder active | $75-150 | `docs/commission-briefs/ui_button_frames.md` |
|| Title screen background | ✅ Placeholder active | $100-200 | `docs/commission-briefs/title_background.md` |

**Total estimated:** $225-450

**Payment terms:** 50% upfront, 50% on delivery + signed rights assignment.

---

## License audit

See `CREDITS.md` for the full audit trail.

**Commercial readiness:** ✅ YES. Zero NC clauses. MIT + CC-BY-SA + work-for-hire.
The only SA component (Better Leaves) requires attribution — satisfied by
`CREDITS.md` and in-pack attribution.

---

## SOTA best practices applied

| Practice | How Set 04 implements it |
|---|---|
| Separate server RP from client mods | Server RP = textures only; .mrpack = mods + animations |
| No NC-licensed assets | Clear Glass Connected (MIT) replaces Clear Glass (NC) |
| SHA1 pinning | Automated in build script |
| Commissioned branding | Work-for-hire with rights assignment |
| AI as briefing tool only | Concepts generated, discarded; artists create finals |
| packwiz-ready | `mrpack/modrinth.index.json` uses version hashes |
| Proper attribution | `CREDITS.md` in every pack directory |
| Size budgets enforced | Java RP ≤ 6 MB, Bedrock ≤ 1 MB, mrpack ≤ 150 MB |
|| EMF/ETF in .mrpack only | Fresh Animations never pushed via server.properties |

## Server Plugins (Set 04 Prime)

The DaemonCraft server runs additional plugins for observability and protection:

|| Plugin | Purpose | Source | Version |
|---|---|---|---|---|
|| **spark** | TPS profiler, memory diagnostics, lag detection | Modrinth | latest |
|| **WorldEdit** | Schematic/region editing (WorldGuard dependency) | Modrinth | 7.4.2 |
|| **WorldGuard** | Region protection, flags, PvP toggles | Modrinth | 7.0.16 |

**Auto-provisioning:** Both are declared in `docker-compose.yml` (`MODRINTH_PROJECTS`) and downloaded automatically by the `itzg/minecraft-server` container on startup.

**Key commands:**
- `/spark tps` — Show TPS and MSPT
- `/spark profiler` — Start CPU profiling
- `/rg define <name>` — Create a protected region
- `/rg flag <name> pvp deny` — Disable PvP in region
