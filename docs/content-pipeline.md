# Sourcing Content for DaemonCraft Visual Layers

How the team gets art, textures, and UI assets into the three pack
slots (`server/data/resourcepacks/daemoncraft-server.zip`,
`client/mrpack/`, `client/mcpack/`) without legal hot water,
without burning weeks on perfectionism, and without painting ourselves
into a corner when the asset author disappears.

This is a runbook, not a spec. Pick the cheapest path that gets you
a thing on screen, then iterate.

---

## What we actually need (current backlog)

| Slot | What | Status | Blocking |
|---|---|---|---|
| Bedrock `.mcpack` | Block textures: leaves, glass remap | placeholder | DC-129 acceptance |
| Bedrock `.mcpack` | `pack_icon.png` (branded, not 256² flat color) | placeholder | DC-129 polish |
| Java client `.mrpack` | "Custom UI pack" slot — title screen, button frames, font | empty | DC-128 task #3 |
| Server RP bundle | Better Leaves + Clear Glass + UI tweaks → `daemoncraft-server.zip` | not built | DC-127 follow-up |
| Server RP bundle | Stable hosting URL (`server.properties:resource-pack`) | undecided | DC-127 / infra |
| Java mrpack | `overrides/servers.dat` with public hostname | empty | infra (hostname not set) |
| Optional | Branded loading-screen overlay (Bedrock + Java) | nice-to-have | — |

Sizes to plan around:
- Java client RP: keep ≤8 MB (server-pushed; first-join download).
- Bedrock `.mcpack`: ≤10 MB (Geyser join-timeout budget, enforced in `scripts/build-mcpack.sh`).
- Java mrpack: total ≤200 MB, mods + RPs combined (Modrinth App
  default budget; bigger packs are slow to import).

---

## The four sourcing paths

Pick **one per asset**. Don't try to be clever and mix five sources
into one icon — license soup is a maintenance nightmare.

### 1. Adapt an existing CC-BY / CC0 pack

**Default for textures.** Minecraft RP creators are generous; the
combination "vanilla-faithful + permissive license" is well covered.

- **License gates:** CC0 = use anything no attribution needed. CC-BY =
  use anything with `CREDITS.md` listing original. CC-BY-SA = use but
  our derivative must also be CC-BY-SA (acceptable but restricts
  later commercial choices). **Avoid CC-BY-ND** (no derivatives — we
  can't remix). **Avoid "All rights reserved"** even if the author
  said "yeah sure use it" in Discord — get it in writing or skip.
- **Where to find:** Modrinth filtered by license, Planet Minecraft's
  resource pack section (search "CC0" or "CC BY"), GitHub topic
  `minecraft-resource-pack`.
- **Watch for:** packs that "include" CC0 textures but the pack itself
  is ARR. The pack license governs the bundle; you can only re-use
  the explicitly-CC0 individual files.

Examples already in our pipeline:
- **Better Leaves** (Motschen) — CC-BY-SA-4.0. Bundled in the Java mrpack.
- **Clear Glass** (LollikiLP) — CC-BY-NC-SA-4.0. ⚠️ NC = non-commercial.
  Fine for our current non-commercial use; revisit if the project ever
  monetizes.
- **Fresh Animations** (FreshLX) — Custom license, allows free use in
  modpacks with attribution. Safe.

**Workflow:**
1. Note the source URL + license + version in `client/<pack>/CREDITS.md`.
2. Drop the assets into the pack tree.
3. If the license requires attribution in-game, add it to
   `manifest.json` `metadata.authors` (Bedrock) or the RP description
   (Java).
4. Commit.

### 2. Commission a single artist

**Default for branding** (logo, pack_icon, custom UI).

- **Cost:** $50-300 per icon, $200-800 for a UI overhaul, depending on
  the artist. Worth it for the things players see every session.
- **License clause to require:** "Work-for-hire, all rights assigned to
  Project, with credit in CREDITS.md and the right to redistribute under
  CC-BY-SA-4.0." Get it in the PO or contract — verbal Discord agreements
  do not survive the artist disappearing.
- **Where to find:** ArtStation Jobs, Reddit r/HungryArtists,
  fiverr/upwork (lower-cost, more variable quality), Twitter/Bluesky
  (call for portfolios).
- **Brief template:** include exact pixel size, target style (vanilla-
  faithful vs cartoony vs gritty — pick one), color palette (we lean
  cyan-purple per the existing brand colour `#2ec4b6`), 2-3 reference
  images of the *vibe* (not the exact thing — they need room to design),
  and a hard deadline.

**Workflow:**
1. Open a `content/COMMISSION-<asset>.md` issue with the brief.
2. Pay 50% upfront, 50% on accepted delivery. Hold the final payment
   until the assignment-of-rights document is signed.
3. Commit the asset + the contract scan into a private folder
   (`docs/contracts/`, gitignored or LFS) so the chain of custody
   survives team turnover.

### 3. Generate with diffusion models

**Default for "we need *a* texture by tomorrow"** — placeholder art
that's better than a flat colour but doesn't pretend to be final.

- **Tools:** Stable Diffusion XL or 3 with a Minecraft-tile LoRA
  (search Civitai for "minecraft texture LoRA"), or DALL-E 3 via OpenAI
  API. SD is free, DALL-E is faster and gives more consistent results.
- **License question (still unsettled in 2026):** US Copyright Office
  position is that pure AI output isn't copyrightable, so technically
  the work is public-domain-ish. EU and others vary. **Practical rule:**
  don't claim copyright over AI-generated assets in our license file,
  and assume someone might copy them. For internal placeholder use this
  is fine. For long-term brand assets, commission (path 2) instead.
- **Watch for:** prompts that name a copyrighted style ("in the style
  of Studio Ghibli") produce output that's legally murky everywhere.
  Stick to descriptive prompts ("hand-painted oak leaves, top-down
  pixel-art tile, 16x16, transparent edges").

**Workflow:**
1. Generate. Iterate the prompt until you get something usable.
2. Downscale + alpha-clean in GIMP/Aseprite — raw SD output is rarely
   usable as-is for a pixel-art texture; you need to align it to the
   16×16 (or 32×32) grid and clean the transparency.
3. Mark it as AI-generated in `CREDITS.md` so the next person knows to
   replace it before any commercial release.

### 4. Internal contribution (someone on the team draws it)

**Default for one-off visual gags** — Pamplinas-themed stickers, scene
holograms, the "welcome" sign in spawn.

- **Tools:** Aseprite ($20, or free if compiled from source) is the
  pixel-art standard. Photopea (browser, free) for non-pixel work.
- **License:** add the contributor to `CONTRIBUTORS.md`; their
  contribution is licensed under the project's umbrella license
  (CC-BY-SA-4.0 for assets unless we change it).
- **Friction:** assumes someone on the team has the time and skill.
  Don't assign this if it'll bottleneck a release — fall back to path 1
  or 3.

---

## Per-asset recommendation (today)

| Asset | Recommended path | Why |
|---|---|---|
| Bedrock leaf textures | **1 (adapt CC pack)** | Several CC-BY-SA Bedrock leaf packs exist on MCPEDL; our budget is "matches Java better-leaves visually" not "perfect parity". |
| Bedrock glass remap | **1 (adapt CC pack)** | Same reasoning — Bedrock community has glass packs. |
| Bedrock `pack_icon.png` | **2 (commission) or 3 (AI placeholder)** | Visible every session in the Bedrock RP picker. Worth $50-100 for a real asset; AI placeholder works in the meantime. |
| Java custom UI pack | **2 (commission)** | UI is high-touch; AI generations look uncanny on buttons and text. The branding investment pays off. |
| Server RP bundle (Better Leaves + Clear Glass + UI) | **1 + 2** | Better Leaves & Clear Glass already sourced (path 1); UI is the path-2 commission above. |
| Loading-screen overlay | **3 (AI) → 2 (commission later)** | Use AI placeholder until DC-128 ships; commission for v1.0 release. |
| `servers.dat` hostname | **infra decision** | Not content; needs the AlterMundi infra team to confirm the public DNS / SRV record. |

---

## Hosting the server resource pack

Once `daemoncraft-server.zip` exists, the server pushes it via
`server.properties`:

```
resource-pack=https://<host>/<path>/daemoncraft-server.zip
resource-pack-sha1=<sha1 of the zip>
resource-pack-prompt=Welcome to DaemonCraft. The pack adds leafy trees and clean glass.
require-resource-pack=false   # do NOT lock players out who decline
```

Hosting options:

1. **`inference01.altermundi.net/packs/`** — already running nginx, we
   control it, sub-second LAN latency. **Recommended.**
2. **GitHub Releases** — public, free, no infra. CDN is decent.
   Downside: every bump is a new release tag.
3. **Hetzner Storage Box** — same place backups go (DC-126). Cheap.
   Downside: needs an HTTP-frontend layer; not natively a CDN.

Pick #1 for the dev cycle. Move to #2 or a real CDN if we ever exceed
~50 concurrent first-time joiners (the bandwidth bottleneck).

**Pin by SHA1.** If the URL serves a different file later than what's
hashed in `server.properties`, every connecting client sees a security
warning and the pack is rejected. Always update both at once; consider
a `Makefile` target:

```makefile
publish-rp:
	@sha1=$$(sha1sum server/resourcepacks/daemoncraft-server.zip | cut -c1-40); \
	scp server/resourcepacks/daemoncraft-server.zip inference01:/var/www/packs/; \
	sed -i "s/resource-pack-sha1=.*/resource-pack-sha1=$$sha1/" server/data/server.properties; \
	docker exec daemoncraft-minecraft mc-send-to-console "reload"
```

---

## License + attribution: the boring file that saves you

Every pack directory gets a `CREDITS.md`. Format:

```markdown
# Credits

## DaemonCraft Bedrock Pack v0.1

| Asset | Source | Author | License |
|---|---|---|---|
| `textures/blocks/leaves_oak.png` | adapted from Foo Pack v3 | @fooauthor | CC-BY-SA-4.0 |
| `pack_icon.png` | commissioned | @baruser | work-for-hire, project-owned |
| `textures/blocks/glass.png` | AI-generated (SDXL + minecraft LoRA) | placeholder | not copyrightable per US Copyright Office 2023 guidance |
```

Why bother:
- **CC-BY-SA requires attribution.** Without `CREDITS.md`, every
  redistribution of our pack is a license violation.
- **Future-you forgets.** Six months in, you won't remember which
  texture was placeholder and which was final. CREDITS.md is your memo.
- **Audit trail.** If an artist DMs us in a year claiming we used their
  work without permission, the file shows where each pixel came from.

---

## Avoiding the "asset bus factor"

Don't accept assets without one of:
- A clear permissive license file (CC0 / CC-BY / CC-BY-SA).
- A signed work-for-hire agreement with rights assignment.
- An email/issue with explicit "you may redistribute under <license>"
  permission, screenshotted into `docs/contracts/`.

The failure mode if you skip this: artist disappears, three years pass,
they reappear and ask for the pack to be taken down. We have no
defense and have to redraw everything.

This applies even to "borrowed from a friend" — get it in writing.

---

## Workflow checklist for the next contributor

When you add a new asset to any pack:

1. **License clear?** If no, stop. Find a different source.
2. **`CREDITS.md` updated?** Add the row.
3. **Pack size still under budget?** Re-run the build script and check.
4. **Reference image saved?** Drop the source/reference into a
   non-shipped `content/source/` directory, gitignored. If you need to
   re-derive the asset later (different size, different palette), the
   source matters.
5. **PR description names the source.** Not just "added new leaves"
   — say "added Foo Pack v3 leaves (CC-BY-SA-4.0)".

---

## Open team questions

- **Brand identity** — do we have a colour palette doc anywhere? If not,
  someone (probably whoever commissions the first UI pack) needs to
  produce one before the artists guess.
- **Voice / tone for in-game text** — Pamplinas's holograms vs sign
  text vs MOTD. Are we committing to ES, EN, or bilingual? The UI pack
  has to ship strings; this matters.
- **Version cadence** — when do we bump pack versions? Per-asset bump,
  or freeze for a release? Tied to the open question of whether DC-128
  ships on Modrinth (which has its own version model) or self-host.
