# Build Notes — Set 02: Branded Hybrid

## Pre-build: commission workflow

```
1. Open `content/COMMISSION-<asset>.md` issue with brief (see commission-briefs/)
2. Artist delivers watermarked preview
3. Accept preview → pay 50% upfront
4. Artist delivers final PNGs + signed rights document
5. Pay remaining 50% ONLY after signed document is in hand
6. Scan document to `docs/contracts/` (gitignored)
7. Commit asset to repo
```

## Commission contract checklist

- [ ] Work-for-hire language explicit
- [ ] All rights assigned to DaemonCraft Project
- [ ] Right to redistribute under CC-BY-SA-4.0
- [ ] Credit in CREDITS.md guaranteed
- [ ] Artist name/alias listed in manifest metadata
- [ ] Hard deadline specified

## Build commands

Same as Set 01, just with commissioned assets in `assets/minecraft/textures/gui/`:

```bash
cd /home/fede/REPOS/daemoncraft

# Java RP
(cd examples/modpack-sets/set-02-branded-hybrid/java-rp && \
 zip -r ../../../../server/data/resourcepacks/daemoncraft-server.zip \
 pack.mcmeta assets/ pack.png)

# SHA1 pin
sha1=$(sha1sum server/data/resourcepacks/daemoncraft-server.zip | cut -c1-40)
sed -i "s|resource-pack-sha1=.*|resource-pack-sha1=$sha1|" server/data/server.properties

# Bedrock pack
(cd examples/modpack-sets/set-02-branded-hybrid/bedrock-mcpack && \
 zip -r daemoncraft-bedrock.mcpack manifest.json textures/ pack_icon.png)
cp examples/modpack-sets/set-02-branded-hybrid/bedrock-mcpack/daemoncraft-bedrock.mcpack \
   server/plugins/Geyser-Spigot/packs/
```

## Gotchas

- **Chain of custody:** If an artist disappears and reappears in 3 years claiming
  unauthorized use, the signed document in `docs/contracts/` is your defense.
- **Do NOT commit contracts to git** unless the repo is private and access-controlled.
  Use gitignore or LFS.
- **Payment hold:** Never pay 100% upfront. The 50/50 split is standard and protects
  both parties.
