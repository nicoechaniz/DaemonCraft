# SOTA Research: Minecraft Server Mods, Plugins & Content Pipelines (2026)

> Research report for DaemonCraft project. Covers Paper/Purpur plugin ecosystem,
> resource pack distribution, cross-play, AI integration, visual enhancements,
> scripting engines, and content licensing.
>
> Date: 2026-05-04

---

## 1. Server-Side Plugin Ecosystem (Paper / Purpur 1.21.x)

**Platform baseline:**
- Paper 1.21.x (builds 100+) — de-facto standard for production servers.
- Purpur — Paper fork with additional mob/Redstone/TNT optimizations and
  per-world configuration. Use Purpur for aggressive tuning; Paper for maximum
  plugin compatibility.

**Essential plugins by category:**

| Category | Plugin | Notes |
|---|---|---|
| Permissions | LuckPerms v5.4+ | Web UI, verbose logging, bulk editor. The only permission plugin that matters. |
| Anti-grief / logging | CoreProtect v22+ | Block/entity/chest logging, rollback, SQLite/MySQL. |
| Regions | WorldGuard v7.0.10+ | Requires WorldEdit. Regions, flags, PvP toggles. |
| Economy | EssentialsX 2.21+ | Economy, warps, kits, AFK. Maintains compatibility aggressively. |
| Profiling | spark | CPU/memory/world tick profiler. Required for any server over 20 players. |
| Analytics | Plan v5.6+ | Web-based player activity, PvP/PvE stats, session tracking. |
| Chat | ChatControl Red / LibreChat | Formatting, channels, ranged chat. |
| Holograms | DecentHolograms | Lightweight, packet-based. Replaced HolographicDisplays as standard. |
| NPCs | Citizens2 + Denizen | NPC engine + scripting (see Section 6). |
| Tablist | TAB v4+ | Tab list, nametags, scoreboard, bossbar. |
| Protocol | ViaVersion / ViaBackwards | Allow 1.20–1.21 clients to join. |
| World map | BlueMap / Dynmap | BlueMap more performant; Dynmap broader plugin integrations. |
| Pre-gen | Chunky | Pre-generation without lag spikes. |

**Notable omissions from DaemonCraft current stack:**
- WorldGuard — no region protection yet (DC-126 follow-up).
- DiscordSRV — no Discord bridge yet (HRM-22 is the bridge epic, but uses custom Flask).
- EssentialsX — not installed; warp/home commands missing.

---

## 2. Resource Pack & Modpack Distribution

**Hosting options:**
1. Self-hosted nginx — full control, bandwidth-limited.
2. GitHub Releases / raw — free, rate-limited (unsuitable for >100 concurrent).
3. **Modrinth CDN** — free for open-source, global edge caching, automatic versioning. **Recommended for public packs.**
4. CurseForge — still dominant for older modpacks; Modrinth has overtaken it for new projects.

**SHA-1 pinning:**
- Mojang still requires SHA-1 for resource-pack integrity checks in the protocol.
- Best practice: compute at build time in CI and inject into `server.properties`.

**.mrpack format:**
- Modrinth modpack format (ZIP-based, JSON manifest) is the de-facto standard.
- CurseForge format remains secondary.
- For server-side modpacks, consider **packwiz** for Git-tracked, auto-updating manifests.

**Fresh pack development workflow:**
1. Build resource pack locally.
2. Upload to Modrinth or self-hosted CDN.
3. CI computes SHA-1 and updates `server.properties`.
4. Clients auto-download on join.

---

## 3. Cross-Play Solutions

**Geyser:**
- Current stable supports Bedrock 1.20.80+ through 1.21.x.
- Standalone (proxy) or plugin mode (Paper/Spigot/Velocity).
- Limitations: anvil/loom GUI quirks, some Redstone behaviors, scoreboard formatting differences.

**Floodgate:**
- Companion auth plugin for Geyser.
- Allows Bedrock players to join online-mode Java servers without Java accounts.
- Global linking API for shared inventory/progress.
- DaemonCraft skips Floodgate because it runs `online-mode=false`.

**Proxy architecture:**
- Velocity 3.x + Geyser + Floodgate recommended for large networks.
- For single-server: Geyser-Spigot works fine.

**Modded cross-play:**
- Geyser-Fabric exists but is experimental.
- Bedrock clients cannot load Java mods. Any modded blocks/GUIs/entities need custom mappings (extremely rare).
- **Recommendation:** keep cross-play to vanilla-like Paper sub-servers; modded Forge/Fabric remains Java-only.

---

## 4. AI Integration in Minecraft Servers

**Bot APIs:**
- **Mineflayer** (Node.js) — mature, plugin-rich (pathfinder, auto-tool, PvP). Best for autonomous agents.
- **MCProtocolLib** (Java) — low-level packet library for custom Java bot logic.

**NPC / scripting engines for AI behavior:**
- **Denizen** — powerful NPC scripting with triggers, waypoints, quest logic (see Section 6).
- **BetonQuest / Quests** — quest plugins for NPC dialogue trees. Less flexible than Denizen.

**LLM integration (GPT / Claude):**
- No dominant native plugin exists as of early 2026.
- Common pattern: external Node.js/Python service connected via:
  1. Plugin custom channel + Denizen script processing chat events.
  2. DiscordSRV bot relaying in-game chat to an AI backend.
  3. Mineflayer bot acting as player-like agent, reading chat and issuing commands via RCON.
- Latency blocker: LLM round-trips 500ms–3s. Too slow for combat, acceptable for NPC dialogue and builder agents.

**Emerging research:**
- Voyager (Microsoft Research, 2023) — LLM-driven skill-learning. Prototype-only.
- MineDojo / STEVE-1 — research environments, not server plugins.
- Baritone — pathfinding/building automation. Client-side (Forge/Fabric), not server.

**DaemonCraft recommendation:**
- Use Mineflayer for "Daemon" bots that interact as players.
- Use Denizen + Citizens2 for static/quest NPCs with scripted dialogue.
- Bridge both to a Python/Node.js LLM orchestrator via WebSocket or Redis pub/sub.

---

## 5. Visual Enhancement Mods

**Resource packs:**
- **Fresh Animations** (FreshLX) — emotes-based entity animations. Extremely popular.
- **Better Leaves / Clear Glass** — simple texture packs; widely bundled.
- **Faithful 32x / Compliance** — standard resolution-upscaled packs.

**Shader support:**
- **Iris** (Fabric/Quilt) / **Oculus** (Forge) — modern shader mod replacing OptiFine for Sodium-based performance.
- **Complementary Shaders v4.7+** — most popular shader pack.
- Server implication: none directly, but shader EULAs sometimes restrict redistribution.

**Model/texture feature mods:**
- **ETF** (Entity Texture Features) 6.x — random/emissive entity textures via OptiFine-format properties.
- **EMF** (Entity Model Features) 2.x — custom entity models without OptiFine. Required by many modern packs including Fresh Animations.
- **Continuity** (Fabric) / **CTM** (Forge) — connected glass/sandstone textures.
- **Sodium + Indium + Lithium** (Fabric) / **Embeddium** (Forge) — performance mods. Embeddium preferred over Rubidium.

**Server policy:**
- Enforce curated optional resource pack via SHA-1 pinning.
- Do not force-install shader mods (client-side only, cannot be enforced via server.properties).

---

## 6. Scripting Engines: Denizen vs Skript vs Others

**Denizen** (https://denizenscript.com):
- Maintained by Citizens2 team (mcmonkey4eva).
- Extremely powerful: full NPC scripting, world events, custom commands, YAML/SQL data, Discord hook.
- Learning curve steep; documentation extensive but dense.
- Performance: compiled to internal triggers; scales well for hundreds of scripted NPCs.
- **Best for:** complex quest systems, procedural NPCs, custom game modes.

**Skript:**
- Original abandoned; community fork (SkriptLang) maintains 1.21 builds.
- English-like syntax; easy for non-programmers.
- Limitations: single-threaded event handling, poor error messages, fragmented addon ecosystem.
- **Best for:** simple automation, custom commands, basic event reactions.

**Other options:**
- **Kether** (TabooLib) — newer, type-safe. Niche adoption.
- **CommandHelper** (MethodScript) — powerful but small community.
- **Java/Kotlin custom plugins** — still best for high-performance custom mechanics at scale.

**Verdict for DaemonCraft:**
- Use Denizen for AI NPCs and quest logic. ✓ (already installed)
- Avoid Skript for anything needing reliability or version longevity.

---

## 7. Content Licensing for Modpacks

**Mod licenses:**
- Most Forge/Fabric mods on Modrinth use OSI-approved licenses (MIT, LGPL, GPL, MPL-2.0).
- CurseForge projects often lack explicit licenses; default copyright applies. Risk when redistributing in standalone modpacks.

**Resource pack / art licenses:**
- CC BY, CC BY-SA, CC0 are standard.
- NC and ND clauses block commercial usage or modification.
- Always verify before bundling in public modpacks or monetized servers.

**Commission contracts:**
- Specify: deliverable format, revision rounds, license grant (exclusive vs non-exclusive), usage scope.
- Work-for-hire is rare in modding; most artists retain copyright and grant a license.

**AI-generated assets:**
- USCO: purely AI-generated works lack human authorship, not copyrightable.
- EU AI Act requires disclosure in some contexts.
- Practical risk: low for decorative textures, but do not rely on AI assets as exclusive IP.
- **Recommendation:** use AI as sketch/drafting tool with human modification. Document the creative process.

**Modpack distribution compliance checklist:**
- [ ] Every mod has declared license compatible with redistribution.
- [ ] Resource packs explicitly licensed for redistribution.
- [ ] Monetization model does not violate NC clauses.
- [ ] Custom assets have signed commission agreements or internal work assignments.

---

## Quick Reference Links

| Project | URL |
|---|---|
| PaperMC | https://papermc.io |
| Purpur | https://purpurmc.org |
| LuckPerms | https://luckperms.net |
| Modrinth | https://modrinth.com |
| GeyserMC | https://geysermc.org |
| Denizen | https://denizenscript.com |
| Mineflayer | https://github.com/PrismarineJS/mineflayer |
| packwiz | https://github.com/packwiz/packwiz |
| Iris Shaders | https://irisshaders.net |
| EMF / ETF | https://modrinth.com/mod/entity-model-features |
