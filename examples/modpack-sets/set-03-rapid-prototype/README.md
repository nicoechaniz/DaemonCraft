# Set 03: Rapid Prototype

**Philosophy:** Generate usable placeholder art in an afternoon using AI
image generation + pixel-art cleanup. Every asset is explicitly marked as
placeholder and non-copyrightable. Perfect for alpha testing, internal demos,
and iterating on visual direction before committing to commissions.

**Sourcing path:** Path 3 (diffusion model generation) → Path 2 later

**Budget:** $0 + 2-4 hours cleanup time

---

## What's inside

| Slot | Source | Status |
|---|---|---|
| Java leaf textures | AI-generated (SDXL + Plixel Minecraft LoRA) | Placeholder |
| Java glass textures | AI-generated (SDXL + Plixel Minecraft LoRA) | Placeholder |
| Java UI elements | AI-generated (DALL-E 3, downscaled) | Placeholder |
| Bedrock leaves | Adapted from AI Java output | Placeholder |
| Bedrock glass | Adapted from AI Java output | Placeholder |
| pack_icon.png | AI-generated (DALL-E 3) | Placeholder |
| Loading overlay | AI-generated (DALL-E 3) | Placeholder |

---

## Generation prompts (documented for reproducibility)

### Block textures (SDXL + Plixel Minecraft LoRA, weight 0.7)

**Oak leaves:**
```
pixel art, Minecraft block texture, oak leaves, top-down view,
16x16 tile, transparent edges, hand-painted style, cyan and purple
accent tones, crisp edges, limited palette, game asset
```

**Clear glass:**
```
pixel art, Minecraft block texture, clear glass block, top-down view,
16x16 tile, transparent edges, slight blue tint, minimal detail,
crisp edges, game asset
```

### pack_icon.png (DALL-E 3, 1024x1024 → downscale)

```
Pixel art logo for a Minecraft server, cyan gem with purple glow,
16-bit style, black background, centered composition, crisp edges,
square format, game icon
```

### Loading overlay (DALL-E 3, 1792x1024 → crop)

```
Pixel art Minecraft landscape at dusk, cyan trees, purple sky,
16-bit style, panoramic composition, atmospheric, game title screen
background, no text
```

---

## Build order

1. Generate 20-30 concepts per asset with DALL-E 3 or SDXL
2. Pick best 2-3 per asset
3. Downscale to target resolution via nearest-neighbor
4. Open in Aseprite; clean transparency, align to 16x16 grid
5. Apply indexed color mode with ~16 colors, force `#2ec4b6` where needed
6. Export PNG, drop into pack tree
7. Mark every AI asset in CREDITS.md as placeholder

---

## When to graduate from this set

- UI elements look "uncanny" on actual buttons → commission Set 02
- Players start screenshotting the placeholder art as "the look" → commission Set 02
- Project approaches any monetization → MUST replace all AI assets before going live
