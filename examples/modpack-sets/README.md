# DaemonCraft Modpack Implementation Examples

Three complete pack sets demonstrating the content-pipeline sourcing paths
defined in `docs/content-pipeline.md`.

| Set | Name | Sourcing Path | Budget | Use Case |
|---|---|---|---|---|
| 01 | Community Commons | Path 1 only (CC-BY/CC0 adaptation) | $0 | Public server, zero legal friction |
| 02 | Branded Hybrid | Path 1 + 2 (CC textures + commissioned branding) | $150-400 | Polished community identity |
| 03 | Rapid Prototype | Path 3 (AI placeholder) | $0 + 2-4h | Internal dev / alpha testing |

Each set contains:
- `java-rp/` — Server-pushed resource pack (`daemoncraft-server.zip`)
- `bedrock-mcpack/` — Bedrock pack for Geyser (`daemoncraft-bedrock.mcpack`)
- `mrpack/` — Modrinth modpack skeleton with forced RP config
- `CREDITS.md` — License audit trail (mandatory per pipeline runbook)
- `docs/build-notes.md` — Set-specific build, hosting, and iteration notes

---

## Quick start

Pick a set, copy its tree into `client/` or `server/`, then:

```bash
cd /home/fede/REPOS/daemoncraft
# Build the Java RP zip
(cd examples/modpack-sets/set-01-community-commons/java-rp && zip -r ../../../../server/data/resourcepacks/daemoncraft-server.zip pack.mcmeta assets/ pack.png)

# Update SHA1
sha1=$(sha1sum server/data/resourcepacks/daemoncraft-server.zip | cut -c1-40)
sed -i "s/resource-pack-sha1=.*/resource-pack-sha1=$sha1/" server/data/server.properties

# Copy Bedrock pack to Geyser
cp examples/modpack-sets/set-01-community-commons/bedrock-mcpack/daemoncraft-bedrock.mcpack \
   server/plugins/Geyser-Spigot/packs/
```

---

## Size budgets (enforced by build scripts)

| Pack | Budget | Set-01 | Set-02 | Set-03 |
|---|---|---|---|---|
| Java RP bundle | <= 8 MB | 2.50 MB (OK) | 2.50 MB (OK) | 0.03 MB (OK) |
| Bedrock `.mcpack` | <= 10 MB | 32 KB (OK) | 24 KB (OK) | 16 KB (OK) |

*All sizes measured after real build. mrpack skeletons are not yet resolved with live mod hashes.*
