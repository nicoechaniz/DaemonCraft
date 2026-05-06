# Commission Brief: DaemonCraft UI Button Frame Set

## Overview
5-10 GUI widget borders for the DaemonCraft Java resource pack. Replaces
vanilla Minecraft's `assets/minecraft/textures/gui/widgets.png` elements.

## Budget
$75-150 USD

## Deliverables
- `widgets.png` sprite sheet (256×256, matching vanilla layout)
- Individual button states: default, hover, disabled, pressed (4 states × 3 sizes)
- Inventory panel background tile
- Title screen button background
- Source file (.ase or .psd with layers)

## Style direction
**Vanilla-faithful with branded accent.** Players should feel "this is still
Minecraft" but with a cohesive visual identity. The frames should be subtle —
the content (buttons, items) is the hero, not the border.

## Color palette
- Frame base: `#1a1a2e` (dark navy — matches vanilla dark UI)
- Frame accent: `#2ec4b6` (cyan — brand color, used on hover/active)
- Frame highlight: `#4cc9f0` (light cyan — top edge glow)
- Frame shadow: `#16213e` (darker navy — bottom edge depth)
- Disabled state: `#555555` (grayed out)

## Specifications
| Element | Size | Notes |
|---|---|---|
| Standard button | 200×20 | Default, hover, active, disabled states |
| Small button | 100×20 | For compact UIs |
| Large button | 200×40 | Title screen primary actions |
| Inventory slot | 18×18 | Slight border around item slots |
| Inventory panel | 176×166 | Crafting table / chest background |
| Title background | 1024×512 | Tiled behind title screen buttons |

## Reference concepts
See `docs/ai-concepts/ui_frame_concepts.png` for 5 AI-generated direction
options. Preferred: concept #2 (clean geometric borders with cyan glow on
hover).

## Constraints
- Must match vanilla widget layout exactly (so Minecraft can slice it correctly)
- No transparency in button frames (Minecraft expects opaque UI sprites)
- Pixel-perfect alignment to 16×16 grid where possible
- Must work in both light and dark inventory contexts

## Timeline
- Concepts: 5-7 days
- Revisions: 3-5 days
- Final delivery: 14 days total

## Rights
Work-for-hire, all rights assigned to DaemonCraft Project. Credit in
`CREDITS.md`. Right to redistribute under CC-BY-SA-4.0.

## Payment
50% upfront on concept approval, 50% on final delivery + signed rights
assignment.
