# DaemonCraft Java Client Modpack (`.mrpack`)

Two-click client install for parents and players: download Modrinth App,
import the `.mrpack`, hit Play. The pack carries Fresh Animations + ETF/EMF
+ Continuity etc. that cannot be delivered server-side.

## Install

1. Download the latest `.mrpack` from `dist/daemoncraft-<version>.mrpack`
   (or the public hosting URL once that lands).
2. Open Modrinth App → "Add Instance" → "From file" → select the `.mrpack`.
3. Wait for download (≤2 min on a decent connection).
4. Hit **Play**. Multiplayer → DaemonCraft entry should be pre-populated.

## What's in the pack

**Performance** — Sodium, Lithium, FerriteCore, ImmediatelyFast.

**Shader pipeline** — Iris + Sodium. Complementary Reimagined shader ships with the
pack but is **off by default** (toggle in Video Settings → Shader Packs). This avoids
choking low-end laptops while giving high-end PCs the full experience.

**Visuals** — Entity Texture Features (ETF), Entity Model Features (EMF),
Continuity. Combined these unlock Fresh Animations + connected textures.

**SOTA ambience (v0.3.0)** —
- **Distant Horizons** — massive LOD render distance (512+ chunks visible)
- **Particular ✨** — fireflies, waterfall cascades, falling leaves, biome ambience
- **Wakes** — realistic water splashes and wakes when swimming/boating
- **Particle Rain** — dense directional rain particles (transforms storms)

**Resource packs (auto-enabled)** — Fresh Animations, Better Leaves,
Clear Glass, DaemonCraft UI.

**Vanity (low overhead, on by default)** — LambDynamicLights (held items
emit light), Falling Leaves.

**Required infrastructure** — Fabric API, Mod Menu, Cloth Config, YACL,
Forge Config API Port.

## Shaders (included, off by default)

Complementary Reimagined r5.7.1 ships with the pack but is **NOT auto-enabled**.
This avoids choking low-end laptops while giving high-end PCs the full experience.

**To enable shaders:**

1. Hit Play, then in-game: Options → Video Settings → Shader Packs.
2. Select "Complementary Reimagined r5.7.1" from the list.
3. Click "Apply".

**Performance tip:** Complementary defaults to "Extreme". Press `K` in-game
to open Iris config and drop to "Medium" or "Low" if FPS drops below 30.

If you prefer a different shader, download any Iris-compatible shader pack
and drop it in the instance's `shaderpacks/` folder.

## Compatibility notes (2026-05-06)

- **Fabric Loader:** Requires 0.18.1+ (manifest pins 0.19.2).
  If Prism/Modrinth auto-selects an older loader, manually bump it.
- **Cloth Config:** Required by FallingLeaves; included since build 2026-05-06.
- **Resource pack format:** All packs updated to `pack_format: 64` for 1.21.11.
  Previously showed "Incompatible — made for an old version" warning.
- **Server resource pack:** Server-pushed RP disabled; `.mrpack` is canonical.
  No more `Failed to parse resource pack prompt` errors.

`manifest.toml` carries pinned `(slug, version_id)` pairs. To bump:

1. Look up the new `version_id` on Modrinth (project page → Versions → ID).
2. Edit `manifest.toml`.
3. Bump `[meta].version` so old/new packs don't clash on file name.
4. `scripts/build-mrpack.sh` — produces `dist/daemoncraft-<version>.mrpack`.

The build script resolves URLs and checksums fresh from the Modrinth API
on every build, so nothing is cached locally. **This means the build needs
network access** and is sensitive to Modrinth API rate limits (~300 req/min
unauthenticated; we issue ~15 per build). Each request has a 30 s timeout.

### Offline / air-gapped builds

If you're on a flaky connection or behind a firewall that blocks Modrinth:

1. Pre-fetch every jar/zip listed in `manifest.toml` once when you have
   connectivity, into `client/mrpack/overrides/mods/` (for mod jars) and
   `client/mrpack/overrides/resourcepacks/` (for RPs). Anything in
   `overrides/` ships verbatim inside the `.mrpack` and skips the
   Modrinth-App download step at install time.
2. Build as usual. The script still needs to query Modrinth for hashes
   to populate `modrinth.index.json`; if that's unavailable, the
   `formatVersion: 1` schema requires at least one entry, so this is a
   limitation rather than a true offline mode. For fully offline builds,
   author `modrinth.index.json` by hand — Modrinth App will then trust
   the `overrides/` files and skip its own download.

For routine bumps from a normal dev box, the live API path is fine.

## Hosting

Two paths once a release is ready:

- **Modrinth** — submit the `.mrpack` as a Modrinth project. Auto-update
  in Modrinth App; reaches the broadest audience.
- **Self-host** — drop on `inference01.altermundi.net/packs/` (or wherever).
  No auto-update; players re-import on bump.

Open question in `plans/DC-128.md`.

## Bedrock parity

Bedrock can't load Java mods. Visual parity (Better Leaves, Clear Glass,
Fresh Animations equivalents) is delivered as a `.mcpack` — see DC-129.
