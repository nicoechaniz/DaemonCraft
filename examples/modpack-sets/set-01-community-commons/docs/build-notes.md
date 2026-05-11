# Build Notes — Set 01: Community Commons

## Asset sourcing checklist

- [ ] Download Better Leaves from Modrinth (Motschen) — verify CC-BY-SA-4.0 badge
- [ ] Download Clear Glass from Modrinth (LollikiLP) — verify CC-BY-NC-SA-4.0 badge
- [ ] Find a CC0 `pack_icon.png` on OpenGameArt or generate a simple 256x256 geometric logo
- [ ] Copy leaf textures to `java-rp/assets/minecraft/textures/block/`
- [ ] Copy glass textures to `java-rp/assets/minecraft/textures/block/`
- [ ] Adapt Bedrock paths: `textures/blocks/leaves_oak.png`, `textures/blocks/glass.png`

## Build commands (already built)

Pre-built artifacts:
- Java RP: `server/data/resourcepacks/daemoncraft-set01.zip` (2.50 MB, SHA1 `b2be34e6b03f3b215277b34821087e9399ae99f4`)
- Bedrock: `server/geyser/packs/daemoncraft-set01.mcpack` (32 KB)

To activate on the live server:
```bash
cd /home/fede/REPOS/daemoncraft
sha1=b2be34e6b03f3b215277b34821087e9399ae99f4
sed -i "s|resource-pack=.*|resource-pack=https://inference01.altermundi.net/packs/daemoncraft-set01.zip|" server/data/server.properties
sed -i "s|resource-pack-sha1=.*|resource-pack-sha1=$sha1|" server/data/server.properties
docker exec -u 1000 daemoncraft-minecraft rcon-cli --password daemoncraft-rcon reload
```

To rebuild from source:
```bash
cd /home/fede/REPOS/daemoncraft

# Java RP
(cd examples/modpack-sets/set-01-community-commons/java-rp && \
 zip -r ../../../../server/data/resourcepacks/daemoncraft-set01.zip \
 pack.mcmeta assets/ pack.png)

# Bedrock pack
(cd examples/modpack-sets/set-01-community-commons/bedrock-mcpack && \
 zip -r daemoncraft-set01.mcpack manifest.json textures/ pack_icon.png)
```

## Gotchas

- **NC clause:** Clear Glass is non-commercial. If you ever add ranks/donations, swap it out first.
- **SA clause:** Both leaf and glass packs are Share-Alike. This entire derivative pack must also be CC-BY-SA-4.0 (or CC-BY-NC-SA-4.0 if Clear Glass is included). Do not add ARR assets to this set.
- **Bedrock `format_version`:** Keep at `2` until Geyser fixes `3` support.
