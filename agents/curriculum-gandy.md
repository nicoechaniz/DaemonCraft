# gAndy Capability Curriculum

Voyager-style progressive task curriculum to systematically evaluate what
Gemma-Andy (4B body orchestrator) handles correctly and where it fails.

Each tier builds on the previous. Tasks marked ✅ = tested and passing.
Tasks marked ❌ = tested and failing. Tasks unmarked = not yet tested.

## Tier 0 — Perception (no world mutation)

| ID | Intent | Tools | Success | Status |
|----|--------|-------|---------|--------|
| P01 | "Look around and report what you see." | scan_nearby | Returns blocks + entities | ✅ |
| P02 | "Check your inventory." | get_inventory | Returns item list with counts | ✅ |
| P03 | "What is your health and hunger?" | (world_state read) | Reports health=20 hunger=20 | |

## Tier 1 — Simple Movement

| ID | Intent | Tools | Success | Status |
|----|--------|-------|---------|--------|
| M01 | "Walk to [nearby coord 4 blocks away]." | goto | Arrives at target ±1 block | ✅ |
| M02 | "Follow the player." | follow | Tracks player movement | |
| M03 | "Stop moving." | stop_movement | Cancels current goal | |
| M04 | "Walk to [distant coord 30 blocks away]." | goto | Arrives without timeout | |
| M05 | "Move away from [entity/coord]." | move_away | Increases distance | |

## Tier 2 — Building (single block)

| ID | Intent | Tools | Success | Status |
|----|--------|-------|---------|--------|
| B01 | "Place a cobblestone block on the ground near you." | place_block | Block materializes, verified with mBit | ✅ |
| B02 | "Place a dirt block on the ground." | place_block | Different material, same pattern | |
| B03 | "Place a block on top of [existing block type]." | scan_nearby → place_block | Places on correct surface | |
| B04 | "Place two cobblestone blocks next to each other." | place_block ×2 | Both blocks adjacent | |

## Tier 3 — Mining

| ID | Intent | Tools | Success | Status |
|----|--------|-------|---------|--------|
| N01 | "Mine one brown_terracotta block." | mine_block | Block broken, item collected | |
| N02 | "Collect 3 orange_terracotta." | mine_block ×3 | 3 items in inventory | |
| N03 | "Mine the block directly below you." | (safety check) | Rejects self-burial | |
| N04 | "Mine a block at [specific coord]." | mine_block | Targets exact coordinate | |

## Tier 4 — Equipment & Inventory

| ID | Intent | Tools | Success | Status |
|----|--------|-------|---------|--------|
| E01 | "Equip your diamond_pickaxe." | get_inventory → equip_item | Pickaxe in hand | |
| E02 | "Equip your netherite_axe." | equip_item | Axe in hand | |
| E03 | "Toss 2 brown_terracotta." | toss_item | Items dropped, count decreased | |
| E04 | "Pick up those items you just dropped." | pickup_item | Items back in inventory | |

## Tier 5 — Multi-Step (2+ actions)

| ID | Intent | Tools | Success | Status |
|----|--------|-------|---------|--------|
| C01 | "Walk to [coord] then place a block there." | goto → place_block | Arrives, places block | |
| C02 | "Mine a block then place a different block in the same spot." | mine_block → place_block | Replaces block | |
| C03 | "Equip pickaxe, mine 1 terracotta, then equip axe." | equip → mine → equip | All 3 succeed in sequence | |

## Tier 6 — Recovery

| ID | Intent | Tools | Success | Status |
|----|--------|-------|---------|--------|
| R01 | Place block at invalid Y, retry with previous_error | place_block (fail) → place_block (retry) | Recovers with valid coord | |
| R02 | Goto unreachable spot, get stuck, recover | goto (fail) → scan → replan | Handles no_path | |
| R03 | Mine target that's too far, move closer first | goto → mine_block | Moves into range | |

## Tier 7 — Complex Building

| ID | Intent | Tools | Success | Status |
|----|--------|-------|---------|--------|
| X01 | "Build a 3×3 cobblestone platform at your feet." | place_block ×9 | 3×3 flat surface | |
| X02 | "Build a 2-block-high pillar where you stand." | place_block ×2 | Vertical stack | |
| X03 | "Build a small L-shaped wall (5 blocks total)." | place_block ×5 | Correct shape | |

## Tier 8 — Integration (multi-category)

| ID | Intent | Tools | Success | Status |
|----|--------|-------|---------|--------|
| I01 | "Gather 3 terracotta, then build a 2×2 platform with it." | mine → place | Items collected, platform built | |
| I02 | "Walk to the player, then build a cobblestone pillar next to them." | follow → place_block | Near player, pillar built | |

---

## Running the curriculum

For each task:
1. Call `embodied_plan(intent=..., allowed_tools=<narrow>, autonomy_level=1)`
2. Observe in `scripts/watch-all.sh`
3. Record: plan quality, tool calls, execution results, elapsed time
4. Mark ✅ or ❌ with brief failure description

## Known gaps (pre-curriculum observations)

- **Spatial enrichment** only fires when intent is classified "build".
  Mining/gathering intents that require placement (e.g. "mine then place")
  may benefit from enrichment on the place sub-intent.
- **Recovery** naive-retry mitigation fires but gAndy doesn't replan
  with scan. The mitigation injects report_execution_error but doesn't
  redirect to valid coordinates.
- **Multi-step** decomposition works for simple sequences ("X then Y")
  but constraints ("avoid hazards", "stay within 3 blocks") sometimes
  become separate sub-intents instead of merging into the prior one.
- **No mBit awareness in gAndy**: gAndy doesn't receive mBit context in
  a format it was trained on. The enrichment solves this for build,
  but navigation and mining still rely on scan_nearby which gives
  aggregate data, not per-block spatial information.
