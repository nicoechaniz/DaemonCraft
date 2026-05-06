# Set 02: Branded Hybrid

**Philosophy:** Layer permissive community textures under professionally
commissioned branding. Players see polished UI and a consistent visual identity;
the project stays legally clean because the underlying block textures are
CC-licensed and the branding is work-for-hire.

**Sourcing paths:** Path 1 (CC textures) + Path 2 (commissioned branding)

**Budget:** $150-400

---

## What's inside

| Slot | Source | License / Rights |
|---|---|---|
| Java Better Leaves | Motschen's Better Leaves | CC-BY-SA-4.0 |
| Java Clear Glass | LollikiLP's Clear Glass | CC-BY-NC-SA-4.0 |
| Java custom UI | Commissioned from pixel artist | Work-for-hire, project-owned |
| Bedrock leaves | Adapted from Better Leaves | CC-BY-SA-4.0 |
| Bedrock glass | Adapted from Clear Glass | CC-BY-NC-SA-4.0 |
| pack_icon.png | Commissioned | Work-for-hire, project-owned |
| Loading overlay | Commissioned | Work-for-hire, project-owned |

---

## Commission briefs (ready to send)

See `docs/commission-briefs/` for copy-paste briefs you can drop into Fiverr,
DeviantArt, or r/HungryArtists.

| Asset | Budget | Deliverable |
|---|---|---|
| `pack_icon.png` | $50-100 | 256x256 branded icon, cyan-purple palette |
| UI button frame set | $75-150 | 5-10 GUI widget borders, vanilla-faithful style |
| Loading overlay | $100-200 | 1920x1080 title screen background |

**Required contract clause:**
> "Work-for-hire, all rights assigned to DaemonCraft Project, with credit in
> CREDITS.md and the right to redistribute under CC-BY-SA-4.0."

---

## Build order

1. Acquire CC textures (same as Set 01)
2. Commission branding assets; hold final 50% payment until rights document is signed
3. Scan signed agreement into `docs/contracts/` (gitignored)
4. Drop commissioned assets into `java-rp/assets/minecraft/textures/gui/`
5. Build and pin SHA1 (same script as Set 01)
