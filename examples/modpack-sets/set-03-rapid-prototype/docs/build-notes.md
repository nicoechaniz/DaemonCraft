# Build Notes — Set 03: Rapid Prototype

## AI generation workflow

### Step 1: Generate concepts

**Option A — DALL-E 3 (fast, consistent, $0.04/image)**
```bash
# Use OpenAI API or web interface. Generate 20-30 variants per asset.
# Prompts are documented in ../README.md
```

**Option B — Stable Diffusion XL + LoRA (free, more control)**
- Base model: SDXL 1.0
- LoRA: "Plixel - Minecraft" (Civitai, SD 1.5) or "[Pixel] Minecraft Items Style" (Pony XL)
- Recommended weight: 0.6-0.8
- CFG: 7-8, Steps: 30-40, Sampler: DPM++ 2M Karras

### Step 2: Downscale

```bash
# Nearest-neighbor resize to target resolution
convert input.png -resize 16x16! -interpolate Nearest -filter point output.png
```

Or online: https://imresizer.com/resize-image-to-16x16

### Step 3: Cleanup in Aseprite

1. Open downscaled PNG
2. `Sprite > Color Mode > Indexed`, palette size ~16
3. Replace accidental anti-aliasing with hard edges
4. Force brand color `#2ec4b6` on accent pixels
5. `File > Export > Export As` → PNG

### Step 4: Mark as placeholder

Update `CREDITS.md` with generator, prompt, and "not copyrightable" notice.

## Build commands

```bash
cd /home/fede/REPOS/daemoncraft

# Java RP
(cd examples/modpack-sets/set-03-rapid-prototype/java-rp && \
 zip -r ../../../../server/data/resourcepacks/daemoncraft-server.zip \
 pack.mcmeta assets/ pack.png)

# SHA1 pin (same script)
sha1=$(sha1sum server/data/resourcepacks/daemoncraft-server.zip | cut -c1-40)
sed -i "s|resource-pack-sha1=.*|resource-pack-sha1=$sha1|" server/data/server.properties

# Bedrock pack
(cd examples/modpack-sets/set-03-rapid-prototype/bedrock-mcpack && \
 zip -r daemoncraft-bedrock.mcpack manifest.json textures/ pack_icon.png)
cp examples/modpack-sets/set-03-rapid-prototype/bedrock-mcpack/daemoncraft-bedrock.mcpack \
   server/plugins/Geyser-Spigot/packs/
```

## Gotchas

- **Do NOT ship this set.** The pipeline runbook explicitly warns against claiming
copyright over AI-generated assets. This set is for internal testing only.
- **DALL-E 3 minimum resolution is 1024x1024.** Raw output must be aggressively
downscaled. Expect to lose detail; the goal is a "better than flat color" placeholder.
- **Civitai LoRA licenses vary.** Check each model's "Allow commercial use" badge.
Even though this set is non-commercial, using a non-commercial-only LoRA restricts
future migration to Set 02.
- **Ghibli clause:** Never use prompts like "in the style of Studio Ghibli" or any
named copyrighted style. Stick to descriptive prompts only.
- **Graduation criteria:** When the team agrees on a visual direction, switch to
Set 02 and commission replacements. Do not iterate AI prompts forever.
