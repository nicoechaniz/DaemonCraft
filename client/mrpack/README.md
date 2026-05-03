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

**Visuals** — Entity Texture Features (ETF), Entity Model Features (EMF),
Continuity. Combined these unlock Fresh Animations + connected textures.

**Resource packs (auto-enabled)** — Fresh Animations, Better Leaves,
Clear Glass.

**Vanity (low overhead, on by default)** — LambDynamicLights (held items
emit light), Falling Leaves.

**Required infrastructure** — Fabric API, Mod Menu.

## Shaders are NOT included

Shipping shaders auto-enabled chokes school laptops at 12 fps. If you want
shaders:

1. Open Modrinth App → DaemonCraft instance → Mods.
2. "+ Add Mod" → search **Iris Shaders** → install.
3. Hit Play, then in-game Options → Video Settings → Shader Packs →
   "Open Shader Pack Folder" and drop e.g. *Complementary Reimagined*.

## Bumping versions

`manifest.toml` carries pinned `(slug, version_id)` pairs. To bump:

1. Look up the new `version_id` on Modrinth (project page → Versions → ID).
2. Edit `manifest.toml`.
3. Bump `[meta].version` so old/new packs don't clash on file name.
4. `scripts/build-mrpack.sh` — produces `dist/daemoncraft-<version>.mrpack`.

The build script resolves URLs and checksums fresh from the Modrinth API
on every build, so nothing is cached locally.

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
