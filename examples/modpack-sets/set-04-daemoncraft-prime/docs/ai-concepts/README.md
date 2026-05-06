# AI Concept Generation for DaemonCraft Prime Commissions

These prompts generate visual briefing material for the commissioned assets in
Set 04. The AI outputs are NOT final assets — they are discarded after the
human artist delivers the commissioned work.

## Workflow

1. Run each prompt 10-20 times
2. Pick the 2-3 best results per asset
3. Save as PNG in this directory
4. Include in commission briefs as "vibe references"
5. Artist creates final, pixel-perfect asset
6. AI concepts are archived (or deleted)

---

## Prompt: pack_icon.png concepts

```
Pixel art logo for a Minecraft server, cyan gem with purple glow,
16-bit style, transparent background, centered composition, crisp edges,
square format, game icon, limited palette, no text
```

Alternative directions:
- `Pixel art friendly daemon spirit, cyan and purple, 16-bit style, transparent background, square format, game icon`
- `Pixel art magical portal gateway, cyan frame with purple energy, 16-bit style, transparent background, square format`
- `Pixel art stylized letter D as a portal, cyan and purple, 16-bit style, transparent background, square format`

## Prompt: UI button frame concepts

```
Pixel art GUI button frame set, dark navy base with cyan accent glow,
16-bit style, Minecraft UI aesthetic, clean geometric borders,
200x20 pixel standard button, hover state highlighted, crisp edges
```

Alternative directions:
- `Pixel art RPG UI frames, dark stone texture with cyan magical runes, 16-bit style, clean borders`
- `Pixel art minimalist UI frames, flat design with subtle cyan gradient, 16-bit style, Minecraft-compatible`

## Prompt: Title screen background concepts

```
Pixel art Minecraft landscape at dusk, cyan trees, purple and pink sky,
16-bit style, panoramic composition, atmospheric, game title screen
background, no text, valley view, fireflies, peaceful mood
```

Alternative directions:
- `Pixel art fantasy forest at twilight, bioluminescent cyan plants, purple sky, 16-bit style, no text`
- `Pixel art Minecraft village at sunset, warm lights, purple sky, cyan forest foreground, 16-bit style, no text`

---

## Tools

- **DALL-E 3** (OpenAI API) — fastest, most consistent
- **Stable Diffusion XL + Plixel Minecraft LoRA** (Civitai) — free, more control
- **Midjourney** — highest quality for atmospheric pieces (title background)

## Cleanup

After commissioning is complete:
```bash
rm -f docs/ai-concepts/*.png
# Keep this README and the prompts for future commissions
```
