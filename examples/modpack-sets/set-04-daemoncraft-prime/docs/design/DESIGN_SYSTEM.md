# DaemonCraft Set 04 Prime — Design System

> **Version:** 1.0.0  
> **Status:** Active (convergence pack)  
> **Scope:** Java RP, Bedrock mcpack, Java client .mrpack, server UI, wiki branding  

---

## 1. Philosophy

**"Vanilla-faithful, branded, alive."**

Set 04 converges the best of Sets 01-03 into a single cohesive visual identity. Players must feel "this is still Minecraft" while experiencing a world that is unmistakably DaemonCraft. The brand is expressed through **color, atmosphere, and motion** — not through loud logos or disruptive textures.

### Design principles

1. **Faithful first** — textures respect vanilla grid, scale, and lighting assumptions.
2. **Atmosphere over announcement** — the brand lives in subtle accents (cyan leaves, purple dusk, glowing UI) rather than stamped logos.
3. **Kid-friendly, not childish** — approachable without being cartoonish. The daemon motif is a *friendly spirit/gateway*, not a horror element.
4. **Pixel-perfect production** — all commissioned assets align to 16×16 or 32×32 apparent pixel grids. No anti-aliasing in final deliverables.
5. **Lightweight** — the server RP must stay under 6 MB so mobile and school-laptop clients load instantly.

---

## 2. Color System

### Primary palette

| Token | Hex | Usage |
|---|---|---|
| `dc-cyan` | `#2ec4b6` | Primary brand color. Leaves, pack icon core, active UI states, particle accents. |
| `dc-purple` | `#9b5de5` | Secondary / magic. Portal glow, sky gradients, hover accents, entity eyes. |
| `dc-pink` | `#f15bb5` | Tertiary highlight. Sunset horizon, rare loot glint, button press feedback. |
| `dc-sky` | `#4cc9f0` | Light variant. Water reflections, sky mid-tones, disabled UI text. |

### Neutral palette

| Token | Hex | Usage |
|---|---|---|
| `dc-navy` | `#1a1a2e` | UI backgrounds, title screen base, dark mode panels. |
| `dc-navy-dark` | `#16213e` | Shadows, depth layers, inventory slot borders. |
| `dc-gray` | `#555555` | Disabled states, inactive buttons, muted text. |
| `dc-warm` | `#fee440` | Warm lights. Village windows, torch bloom, campfire accents. |

### Gradient prescriptions

- **Sky (title screen):** `dc-navy` → `dc-purple` → `dc-pink` (top → mid → horizon)
- **Water reflection:** `dc-sky` → `dc-purple` (shallow → deep)
- **UI button hover:** `dc-navy` → `dc-cyan` edge glow (1-2 pixel rim)
- **Leaves tint:** `dc-cyan` base with `dc-navy-dark` shadow pixels

---

## 3. Typography (Pixel-Art Text)

Minecraft uses its own pixel font. We do **not** replace it. Instead, we influence typography through:

- **Color:** Server MOTD uses `dc-cyan` + `dc-purple` with vanilla § color codes.
- **Layout:** Scoreboard, tab list, and action bar spacing tuned for readability.
- **No custom fonts** in the resource pack — avoids localization and encoding issues.

### Text styling rules

| Context | Color | Background |
|---|---|---|
| Server name (MOTD) | `dc-cyan` + bold | `dc-navy` |
| Player count | `dc-sky` | transparent |
| Event announcements | `dc-pink` + bold | `dc-navy` (action bar) |
| Error / danger | `#ff4444` (vanilla red) | transparent |

---

## 4. Asset Specifications

### 4.1 Pack Icon (`pack.png` / `pack_icon.png`)

- **Sizes:** 256×256 (primary), 64×64 (server list thumbnail)
- **Format:** PNG-24 with transparency ( Bedrock ), PNG-24 opaque or transparent ( Java )
- **Style:** 16-bit pixel art, limited palette (~16 colors), crisp edges
- **Motif:** Stylized daemon/portal — reads as "magical gateway" or "friendly spirit"
- **Constraints:** No text, no gradients, no Minecraft IP, must read at 64×64

### 4.2 UI Button Frame Set (`widgets.png` sprite sheet)

- **Size:** 256×256 (vanilla layout)
- **States:** default, hover, active/pressed, disabled
- **Button sizes:** 200×20 (standard), 100×20 (small), 200×40 (large/title)
- **Slot border:** 18×18 (1px accent frame)
- **Panel background:** 176×166 (crafting/chest), tileable
- **Title background:** 1024×512 (static) or 6× 1024×1024 (panorama cube)

### 4.3 Title Screen Background

- **Static:** 1920×1080 PNG, pixel-art landscape
- **Panorama (optional):** 6× 1024×1024 cube faces, seamless loop
- **Scene:** Hilltop overlooking forest valley at dusk
- **Center calm zone:** Low-contrast area for logo + buttons (center 40% of image)

### 4.4 Server Resource Pack (`daemoncraft-prime.zip`)

- **Size limit:** ≤ 6 MB
- **Contents:**
  - `assets/minecraft/textures/block/` — leaves, glass (community CC/MIT)
  - `assets/minecraft/textures/gui/` — branded UI frames (commissioned)
  - `assets/minecraft/textures/gui/title/background/` — title bg (commissioned)
  - `pack.png` — branded icon (commissioned)
  - `pack.mcmeta` — metadata
- **Excluded:** Entity animations (live in .mrpack only), shaders, heavy audio

### 4.5 Bedrock `.mcpack`

- **Size limit:** ≤ 1 MB
- **Contents:** Adapted textures from Java RP, matching `pack_icon.png`
- **UUIDs:** Stable across versions (see `manifest.json`)

### 4.6 Client `.mrpack`

- **Size limit:** ≤ 150 MB
- **Contents:** Fabric mods + resource packs + config overrides
- **Mods:** Sodium, Lithium, FerriteCore, ImmediatelyFast, Fabric API, ModMenu, EMF, ETF, Continuity, LambDynamicLights, FallingLeaves
- **Resource packs:** Fresh Animations, Better Leaves, Clear Glass, Branded UI
- **Config:** `resourcepackoverrides.json` forcing load order

---

## 5. Motion & Interaction

### UI feedback

| State | Visual treatment |
|---|---|
| Default button | `dc-navy` fill, 1px `dc-navy-dark` shadow bottom/right |
| Hover | 1px `dc-cyan` rim glow top/left, subtle brighten |
| Pressed | Shift 1px down/right, `dc-navy-dark` fill, no glow |
| Disabled | `dc-gray` fill, no shadow, 50% opacity suggestion |

### Particle accents

- **Ambient:** Mycelium particles retinted to `dc-cyan` (subtle world atmosphere)
- **Portal:** Nether portal particles unchanged (vanilla is already purple — aligns with `dc-purple`)
- **Loot glint:** Rare items get `dc-pink` enchantment glint override (optional)

---

## 6. Coherence Checklist

Before any asset is approved for the pack, verify:

- [ ] Uses only palette colors (no rogue hues)
- [ ] Aligns to pixel grid (no subpixel positioning)
- [ ] Reads correctly at target size (64×64 for icon, 200×20 for button)
- [ ] Matches vanilla layout (for UI sprites)
- [ ] Has transparent or correct background (no checkerboard artifacts)
- [ ] File size is within budget (see §4)
- [ ] License is clean (CC-BY-SA, MIT, or work-for-hire)
- [ ] Attribution is added to `CREDITS.md`

---

## 7. AI Concept → Commission Pipeline

1. **Generate 10-20 concepts** per asset using prompts in `docs/ai-concepts/README.md`
2. **Pick 2-3 finalists** against the coherence checklist
3. **Include finalists** in commission brief as "vibe references"
4. **Artist delivers pixel-perfect finals** following this Design System
5. **AI concepts are archived** (or deleted) — they are briefing material only

---

## 8. Version History

| Version | Date | Changes |
|---|---|---|
| 1.0.0 | 2026-05-04 | Initial design system for Set 04 Prime convergence |
