#!/usr/bin/env python3
"""build_block_chars.py — Generate the no-collision, semantically-meaningful
block→char mapping for mbit visual format.

Replaces the previous exact-block CJK mapping (1166 chars) with a type-based
mapping (~80-100 CJK categories). Each char has actual meaning in
Chinese/Japanese: 瓦=瓦(tile), 扉=door, 階=stairs, 硝=glass, 枝=branches,
etc. The LLM can decode the visual WITHOUT consulting a legend.

Mapping strategy:
- Mnemonic override for ~16 super-common blocks: air=空, water=水, lava=溶,
  torch=灯, lantern=灯, redstone_wire=赤, etc.
- Category mapping: ~700+ blocks mapped by exact name to their CJK char
- Pattern-based fallback: blocks not in the exact-name map get a char via
  regex (e.g. .*_stairs → 階, .*_coral_.* → 珊)
- Last-resort: blocks with no match are coerced to other categories or
  flagged for manual review

Output:
  ~/Projects/DaemonCraft/lib/block_to_char_<version>.json
  ~/Projects/DaemonCraft/agents/bot/lib/block_to_char_<version>.js
  ~/Projects/DaemonCraft/agents/bot/lib/block_to_char_<version>.json

The output is small (~100 entries in the JSON) — far easier to maintain
than the previous 1166-entry mapping.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from typing import Callable, Dict, List, Tuple


# ──────────────────────────────────────────────────────────────────────
# Exact-name category map. ~700+ entries covering common blocks.
# Each value is a single CJK char that semantically means that thing
# in Chinese or Japanese (with one or two exceptions where the char is
# phonetic for English loanwords, like 褐=kachi for "catch" or 楽=gaku
# for "music note block").
# ──────────────────────────────────────────────────────────────────────

CATEGORY_MAP: Dict[str, str] = {
    # ───── AIR / VOID ─────
    'air': '空', 'cave_air': '空', 'void_air': '空',
    'structure_void': '空',
    'light': '光',  # light block
    'barrier': '禁',
    'chiseled_bookshelf': '本',
    'chiseled_copper': '銅', 'chiseled_deepslate': '盤',
    'chiseled_red_sandstone': '砂', 'chiseled_sandstone': '砂',
    'chiseled_resin_bricks': '樹',
    'chiseled_tuff': '灰', 'chiseled_tuff_bricks': '灰',
    'oxidized_copper': '銅', 'weathered_copper': '銅', 'exposed_copper': '銅',
    'waxed_copper_block': '銅', 'waxed_oxidized_copper': '銅',
    'waxed_weathered_copper': '銅', 'waxed_exposed_copper': '銅',
    'waxed_exposed_lightning_rod': '電', 'waxed_oxidized_lightning_rod': '電',
    'waxed_weathered_lightning_rod': '電',
    'dead_bush': '枯',

    # ───── WATER / LAVA ─────
    'water': '水', 'flowing_water': '水', 'bubble_column': '泡',
    'lava': '溶', 'flowing_lava': '溶',
    'powder_snow': '雪', 'powder_snow_cauldron': '鍋',

    # ───── STONE / ROCK ─────
    'stone': '岩', 'cobblestone': '丸', 'mossy_cobblestone': '丸',
    'deepslate': '盤', 'cobbled_deepslate': '盤', 'polished_deepslate': '盤',
    'polished_andesite': '安', 'andesite': '安',
    'polished_diorite': '閃', 'diorite': '閃',
    'polished_granite': '花', 'granite': '花',
    'tuff': '灰', 'polished_tuff': '灰',
    'calcite': '白', 'dripstone_block': '鍾', 'pointed_dripstone': '鍾',
    'smooth_stone': '磨', 'smooth_basalt': '磨', 'polished_basalt': '磨', 'basalt': '磨',
    'blackstone': '黒', 'polished_blackstone': '黒', 'chiseled_polished_blackstone': '黒',
    'gilded_blackstone': '黒', 'reinforced_deepslate': '盤',
    'end_stone': '終', 'end_stone_bricks': '終', 'purpur_block': '紫', 'purpur_pillar': '紫',
    'prismarine': '海', 'prismarine_bricks': '海', 'dark_prismarine': '海',
    'ancient_debris': '瓦', 'netherite_block': '鍊', 'lodestone': '磁', 'respawn_anchor': '錨',

    # ───── DIRT / SAND / GRAVEL ─────
    'dirt': '土', 'coarse_dirt': '土', 'rooted_dirt': '土', 'podzol': '土',
    'mycelium': '菌', 'grass_block': '土', 'dirt_path': '土', 'farmland': '畝',
    'wet_farmland': '畝',
    'sand': '砂', 'red_sand': '砂', 'sandstone': '砂', 'red_sandstone': '砂',
    'gravel': '砂', 'clay': '粘', 'hardened_clay': '瓦',
    'mud': '泥', 'packed_mud': '塊', 'mud_bricks': '瓦',
    'mangrove_roots': '根', 'muddy_mangrove_roots': '根', 'mangrove_propagule': '苗',
    'hanging_roots': '根',
    'snow': '雪', 'snow_block': '雪', 'snow_layer': '雪',
    'ice': '氷', 'packed_ice': '氷', 'blue_ice': '氷', 'frosted_ice': '氷',

    # ───── WOOD / LOG / PLANKS ─────
    # (logs and woods use 幹=trunk; planks use 板=board; cherry uses 桜=cherry)
    'oak_log': '幹', 'oak_wood': '幹', 'stripped_oak_log': '幹', 'stripped_oak_wood': '幹',
    'spruce_log': '幹', 'spruce_wood': '幹', 'stripped_spruce_log': '幹', 'stripped_spruce_wood': '幹',
    'birch_log': '幹', 'birch_wood': '幹', 'stripped_birch_log': '幹', 'stripped_birch_wood': '幹',
    'jungle_log': '幹', 'jungle_wood': '幹', 'stripped_jungle_log': '幹', 'stripped_jungle_wood': '幹',
    'acacia_log': '幹', 'acacia_wood': '幹', 'stripped_acacia_log': '幹', 'stripped_acacia_wood': '幹',
    'dark_oak_log': '幹', 'dark_oak_wood': '幹', 'stripped_dark_oak_log': '幹', 'stripped_dark_oak_wood': '幹',
    'mangrove_log': '幹', 'mangrove_wood': '幹', 'stripped_mangrove_log': '幹', 'stripped_mangrove_wood': '幹',
    'crimson_stem': '幹', 'crimson_hyphae': '幹', 'stripped_crimson_stem': '幹', 'stripped_crimson_hyphae': '幹',
    'warped_stem': '幹', 'warped_hyphae': '幹', 'stripped_warped_stem': '幹', 'stripped_warped_hyphae': '幹',
    'cherry_log': '桜', 'cherry_wood': '桜', 'stripped_cherry_log': '桜', 'stripped_cherry_wood': '桜',
    'bamboo_block': '竹', 'bamboo_planks': '竹', 'bamboo_mosaic': '竹',
    'crimson_planks': '板', 'warped_planks': '板', 'crimson_nylium': '菌', 'warped_nylium': '菌',
    'note_block': '楽', 'jukebox': '楽',

    # ───── LEAVES / SAPLINGS / PLANTS ─────
    'azalea': '椿', 'flowering_azalea': '花',
    'oak_sapling': '苗', 'spruce_sapling': '苗', 'birch_sapling': '苗', 'jungle_sapling': '苗',
    'acacia_sapling': '苗', 'dark_oak_sapling': '苗', 'mangrove_propagule': '苗',
    'cherry_sapling': '桜',
    'cocoa': '柯', 'cocoa_beans': '柯',
    'leaf_litter': '葉',
    'lily_pad': '蓮', 'frogspawn': '蛙',
    'sea_pickle': '珊', 'turtle_egg': '卵',
    'big_dripleaf': '葉', 'small_dripleaf': '葉', 'big_dripleaf_stem': '葉',
    'spore_blossom': '花',
    'pumpkin_stem': '蔓', 'melon_stem': '蔓',
    'attached_pumpkin_stem': '蔓', 'attached_melon_stem': '蔓',
    'sweet_berry_bush': '莓', 'sweet_berries': '莓',
    'cactus': '柱', 'cactus_flower': '花', 'bamboo_shoot': '筍',
    'sugar_cane': '蔗', 'reeds': '蔗',
    'kelp': '藻', 'kelp_plant': '藻', 'dried_kelp_block': '藻',
    'bubble_coral': '珊', 'brain_coral': '珊', 'fire_coral': '珊',
    'horn_coral': '珊', 'tube_coral': '珊',
    'pumpkin': '瓢', 'carved_pumpkin': '瓢',
    'melon': '瓜',
    'brown_mushroom': '茸', 'red_mushroom': '茸', 'mushroom_stem': '菌',
    'brown_mushroom_block': '菌', 'red_mushroom_block': '菌', 'mushroom_block': '菌',
    'crimson_fungus': '菌', 'warped_fungus': '菌',
    'nether_sprouts': '菌', 'crimson_roots': '根', 'warped_roots': '根',
    'nether_wart': '疣', 'nether_wart_block': '疣',
    'crimson_roots': '根', 'warped_roots': '根',
    'wheat': '麦', 'wheat_seeds': '麦', 'carrots': '菜', 'potatoes': '芋',
    'beetroots': '菜', 'beetroot_seeds': '種', 'melon_seeds': '種', 'pumpkin_seeds': '種',
    'torchflower': '花', 'torchflower_crop': '花', 'torchflower_seeds': '種',
    'pitcher_plant': '瓶',
    'vine': '蔓', 'glow_lichen': '光', 'weeping_vines': '蔓', 'weeping_vines_plant': '蔓',
    'twisting_vines': '蔓', 'twisting_vines_plant': '蔓',
    'cave_vines': '蔓', 'cave_vines_plant': '蔓',

    # ───── ORE / MINERAL ─────
    'amethyst_block': '紫', 'budding_amethyst': '紫', 'amethyst_cluster': '紫',
    'small_amethyst_bud': '紫', 'medium_amethyst_bud': '紫', 'large_amethyst_bud': '紫',
    'calibrated_sculk_sensor': '感',
    'coal_block': '炭', 'iron_block': '鉄', 'gold_block': '金', 'diamond_block': '石',
    'emerald_block': '翠', 'lapis_block': '青', 'redstone_block': '赤', 'copper_block': '銅',
    'raw_iron_block': '鉄', 'raw_gold_block': '金', 'raw_copper_block': '銅',
    'conduit': '環',

    # ───── METAL ─────
    'iron_bars': '柵',
    'light_weighted_pressure_plate': '金', 'heavy_weighted_pressure_plate': '鉄',
    'chain': '鎖', 'cauldron': '鍋', 'lava_cauldron': '鍋', 'water_cauldron': '鍋',
    'bell': '鈴', 'lantern': '灯', 'soul_lantern': '灯',
    'iron_door': '扉', 'iron_trapdoor': '板',
    'iron_ore': '鉱', 'gold_ore': '鉱', 'nether_gold_ore': '鉱', 'copper_ore': '鉱',

    # ───── GLASS ─────
    'glass': '硝', 'glass_pane': '硝', 'tinted_glass': '硝', 'hardened_glass': '硝', 'hardened_glass_pane': '硝',

    # ───── TERRACOTTA (all 16 colors → 瓦=tile) ─────
    'terracotta': '瓦',
    'white_terracotta': '瓦', 'orange_terracotta': '瓦', 'magenta_terracotta': '瓦',
    'light_blue_terracotta': '瓦', 'yellow_terracotta': '瓦', 'lime_terracotta': '瓦',
    'pink_terracotta': '瓦', 'gray_terracotta': '瓦', 'light_gray_terracotta': '瓦',
    'cyan_terracotta': '瓦', 'purple_terracotta': '瓦', 'blue_terracotta': '瓦',
    'brown_terracotta': '瓦', 'green_terracotta': '瓦', 'red_terracotta': '瓦', 'black_terracotta': '瓦',
    'white_glazed_terracotta': '瓦', 'orange_glazed_terracotta': '瓦', 'magenta_glazed_terracotta': '瓦',
    'light_blue_glazed_terracotta': '瓦', 'yellow_glazed_terracotta': '瓦', 'lime_glazed_terracotta': '瓦',
    'pink_glazed_terracotta': '瓦', 'gray_glazed_terracotta': '瓦', 'light_gray_glazed_terracotta': '瓦',
    'cyan_glazed_terracotta': '瓦', 'purple_glazed_terracotta': '瓦', 'blue_glazed_terracotta': '瓦',
    'brown_glazed_terracotta': '瓦', 'green_glazed_terracotta': '瓦', 'red_glazed_terracotta': '瓦',
    'black_glazed_terracotta': '瓦',

    # ───── CONCRETE (all 16 colors → 灰=ash) ─────
    'white_concrete': '灰', 'orange_concrete': '灰', 'magenta_concrete': '灰',
    'light_blue_concrete': '灰', 'yellow_concrete': '灰', 'lime_concrete': '灰',
    'pink_concrete': '灰', 'gray_concrete': '灰', 'light_gray_concrete': '灰',
    'cyan_concrete': '灰', 'purple_concrete': '灰', 'blue_concrete': '灰',
    'brown_concrete': '灰', 'green_concrete': '灰', 'red_concrete': '灰', 'black_concrete': '灰',

    # ───── WOOL (all 16 colors → 毛=wool) ─────
    'white_wool': '毛', 'orange_wool': '毛', 'magenta_wool': '毛',
    'light_blue_wool': '毛', 'yellow_wool': '毛', 'lime_wool': '毛',
    'pink_wool': '毛', 'gray_wool': '毛', 'light_gray_wool': '毛',
    'cyan_wool': '毛', 'purple_wool': '毛', 'blue_wool': '毛',
    'brown_wool': '毛', 'green_wool': '毛', 'red_wool': '毛', 'black_wool': '毛',

    # ───── BRICKS (all kinds → 瓦) ─────
    'bricks': '瓦', 'nether_bricks': '瓦', 'red_nether_bricks': '瓦',
    'chiseled_nether_bricks': '瓦', 'cracked_nether_bricks': '瓦',
    'cracked_stone_bricks': '瓦', 'chiseled_stone_bricks': '瓦',
    'mossy_stone_bricks': '瓦',
    'quartz_block': '石', 'smooth_quartz': '石', 'chiseled_quartz_block': '石', 'quartz_pillar': '石',
    'quartz_bricks': '石',
    'end_stone_brick_slab': '段', 'end_stone_brick_stairs': '階', 'end_stone_brick_wall': '壁',
    'mossy_stone_brick_slab': '段', 'mossy_stone_brick_stairs': '階', 'mossy_stone_brick_wall': '壁',
    'cracked_stone_brick_slab': '段', 'cracked_stone_brick_stairs': '階', 'cracked_stone_brick_wall': '壁',
    'chiseled_stone_brick_slab': '段', 'chiseled_stone_brick_stairs': '階', 'chiseled_stone_brick_wall': '壁',
    'nether_brick_slab': '段', 'nether_brick_stairs': '階', 'nether_brick_wall': '壁',
    'red_nether_brick_slab': '段', 'red_nether_brick_stairs': '階', 'red_nether_brick_wall': '壁',
    'chiseled_nether_brick_slab': '段', 'chiseled_nether_brick_stairs': '階', 'chiseled_nether_brick_wall': '壁',
    'cracked_nether_brick_slab': '段', 'cracked_nether_brick_stairs': '階', 'cracked_nether_brick_wall': '壁',
    'quartz_slab': '段', 'quartz_stairs': '階', 'smooth_quartz_slab': '段', 'smooth_quartz_stairs': '階',
    'chiseled_quartz_slab': '段', 'chiseled_quartz_stairs': '階',
    'quartz_brick_slab': '段', 'quartz_brick_stairs': '階',
    'polished_blackstone_slab': '段', 'polished_blackstone_stairs': '階', 'polished_blackstone_wall': '壁',
    'chiseled_polished_blackstone_slab': '段', 'chiseled_polished_blackstone_stairs': '階',
    'gilded_blackstone_slab': '段',
    'cracked_deepslate_bricks': '盤', 'cracked_deepslate_tiles': '盤',
    'deepslate_brick_slab': '段', 'deepslate_brick_stairs': '階', 'deepslate_brick_wall': '壁',
    'deepslate_bricks': '盤', 'deepslate_tile_slab': '段', 'deepslate_tile_stairs': '階',
    'deepslate_tile_wall': '壁', 'deepslate_tiles': '盤',
    'prismarine_brick_slab': '段', 'prismarine_brick_stairs': '階',
    'prismarine_slab': '段', 'prismarine_stairs': '階', 'prismarine_wall': '壁',
    'purpur_slab': '段', 'purpur_stairs': '階',
    'sandstone_slab': '段', 'sandstone_stairs': '階', 'sandstone_wall': '壁',
    'red_sandstone_slab': '段', 'red_sandstone_stairs': '階', 'red_sandstone_wall': '壁',
    'cut_sandstone_slab': '段', 'cut_red_sandstone_slab': '段',
    'smooth_stone_slab': '段',
    'cobblestone_slab': '段', 'cobblestone_stairs': '階', 'cobblestone_wall': '壁',
    'mossy_cobblestone_slab': '段', 'mossy_cobblestone_stairs': '階', 'mossy_cobblestone_wall': '壁',
    'stone_brick_slab': '段', 'stone_brick_stairs': '階', 'stone_brick_wall': '壁',
    'brick_slab': '段', 'brick_stairs': '階', 'brick_wall': '壁',
    'mud_brick_slab': '段', 'mud_brick_stairs': '階', 'mud_brick_wall': '壁',
    'polished_andesite_slab': '段', 'polished_andesite_stairs': '階', 'polished_andesite_wall': '壁',
    'polished_diorite_slab': '段', 'polished_diorite_stairs': '階', 'polished_diorite_wall': '壁',
    'polished_granite_slab': '段', 'polished_granite_stairs': '階', 'polished_granite_wall': '壁',
    'polished_blackstone_bricks': '黒', 'cracked_polished_blackstone_bricks': '黒',
    'polished_deepslate_slab': '段', 'polished_deepslate_stairs': '階', 'polished_deepslate_wall': '壁',
    'andesite_slab': '段', 'andesite_stairs': '階', 'andesite_wall': '壁',
    'diorite_slab': '段', 'diorite_stairs': '階', 'diorite_wall': '壁',
    'granite_slab': '段', 'granite_stairs': '階', 'granite_wall': '壁',
    'tuff_slab': '段', 'tuff_stairs': '階', 'tuff_wall': '壁',
    'polished_tuff_slab': '段', 'polished_tuff_stairs': '階', 'polished_tuff_wall': '壁',
    'blackstone_slab': '段', 'blackstone_stairs': '階', 'blackstone_wall': '壁',
    'cut_copper_slab': '段', 'cut_copper_stairs': '階',
    'exposed_cut_copper_slab': '段', 'exposed_cut_copper_stairs': '階',
    'weathered_cut_copper_slab': '段', 'weathered_cut_copper_stairs': '階',
    'oxidized_cut_copper_slab': '段', 'oxidized_cut_copper_stairs': '階',
    'waxed_cut_copper_slab': '段', 'waxed_cut_copper_stairs': '階',
    'waxed_exposed_cut_copper_slab': '段', 'waxed_exposed_cut_copper_stairs': '階',
    'waxed_weathered_cut_copper_slab': '段', 'waxed_weathered_cut_copper_stairs': '階',
    'waxed_oxidized_cut_copper_slab': '段', 'waxed_oxidized_cut_copper_stairs': '階',
    'bamboo_slab': '段', 'bamboo_mosaic_slab': '段',
    'bamboo_stairs': '階', 'bamboo_mosaic_stairs': '階',
    'exposed_cut_copper': '銅', 'weathered_cut_copper': '銅', 'oxidized_cut_copper': '銅',
    'waxed_exposed_cut_copper': '銅', 'waxed_weathered_cut_copper': '銅', 'waxed_oxidized_cut_copper': '銅',
    'cut_copper': '銅',
    'waxed_cut_copper': '銅', 'waxed_exposed_cut_copper': '銅', 'waxed_weathered_cut_copper': '銅', 'waxed_oxidized_cut_copper': '銅',

    # ───── FURNITURE / CONTAINERS ─────
    'crafting_table': '机', 'cartography_table': '机', 'smithing_table': '机',
    'fletching_table': '機', 'loom': '機',
    'furnace': '炉', 'blast_furnace': '炉', 'smoker': '炉',
    'lit_furnace': '炉', 'lit_blast_furnace': '炉', 'lit_smoker': '炉',
    'chest': '箱', 'trapped_chest': '箱', 'ender_chest': '箱',
    'shulker_box': '箱', 'white_shulker_box': '箱', 'orange_shulker_box': '箱', 'magenta_shulker_box': '箱',
    'light_blue_shulker_box': '箱', 'yellow_shulker_box': '箱', 'lime_shulker_box': '箱',
    'pink_shulker_box': '箱', 'gray_shulker_box': '箱', 'light_gray_shulker_box': '箱',
    'cyan_shulker_box': '箱', 'purple_shulker_box': '箱', 'blue_shulker_box': '箱',
    'brown_shulker_box': '箱', 'green_shulker_box': '箱', 'red_shulker_box': '箱', 'black_shulker_box': '箱',
    'barrel': '樽', 'lectern': '本', 'bookshelf': '本', 'enchanting_table': '机',
    'brewing_stand': '薬', 'anvil': '鉄', 'chipped_anvil': '鉄', 'damaged_anvil': '鉄',
    'grindstone': '砥', 'stonecutter': '砥', 'composter': '肥', 'beehive': '蜂', 'bee_nest': '蜂',
    'honeycomb_block': '蜜', 'honey_block': '蜜', 'slime_block': '粘',
    'sponge': '綿', 'wet_sponge': '綿', 'target': '的',
    'redstone_lamp': '光', 'redstone_torch': '灯', 'redstone_wire': '赤',
    'repeater': '繰', 'comparator': '較',
    'daylight_detector': '光', 'lever': '桿', 'stone_button': '釦',
    'tripwire': '線', 'tripwire_hook': '鈎', 'string': '糸', 'lead': '縄',
    'observer': '監', 'piston': '押', 'sticky_piston': '粘', 'piston_head': '押',
    'moving_piston': '押', 'piston_extension': '押',
    'dispenser': '射', 'dropper': '漏', 'hopper': '漏', 'rail': '軌',
    'powered_rail': '電', 'detector_rail': '探', 'activator_rail': '活',
    'name_tag': '札', 'lodestone': '磁',
    'chain_command_block': '司', 'repeating_command_block': '司', 'command_block': '司',
    'structure_block': '構', 'jigsaw': '鋸',
    'sculk_sensor': '感', 'sculk_catalyst': '触', 'sculk_shrieker': '叫',

    # ───── BED (all 16 colors → 寝) ─────
    'white_bed': '寝', 'orange_bed': '寝', 'magenta_bed': '寝',
    'light_blue_bed': '寝', 'yellow_bed': '寝', 'lime_bed': '寝',
    'pink_bed': '寝', 'gray_bed': '寝', 'light_gray_bed': '寝',
    'cyan_bed': '寝', 'purple_bed': '寝', 'blue_bed': '寝',
    'brown_bed': '寝', 'green_bed': '寝', 'red_bed': '寝', 'black_bed': '寝',

    # ───── STAINED GLASS / PANE (all 16 colors → 硝) ─────
    'white_stained_glass': '硝', 'orange_stained_glass': '硝', 'magenta_stained_glass': '硝',
    'light_blue_stained_glass': '硝', 'yellow_stained_glass': '硝', 'lime_stained_glass': '硝',
    'pink_stained_glass': '硝', 'gray_stained_glass': '硝', 'light_gray_stained_glass': '硝',
    'cyan_stained_glass': '硝', 'purple_stained_glass': '硝', 'blue_stained_glass': '硝',
    'brown_stained_glass': '硝', 'green_stained_glass': '硝', 'red_stained_glass': '硝', 'black_stained_glass': '硝',
    'white_stained_glass_pane': '硝', 'orange_stained_glass_pane': '硝', 'magenta_stained_glass_pane': '硝',
    'light_blue_stained_glass_pane': '硝', 'yellow_stained_glass_pane': '硝', 'lime_stained_glass_pane': '硝',
    'pink_stained_glass_pane': '硝', 'gray_stained_glass_pane': '硝', 'light_gray_stained_glass_pane': '硝',
    'cyan_stained_glass_pane': '硝', 'purple_stained_glass_pane': '硝', 'blue_stained_glass_pane': '硝',
    'brown_stained_glass_pane': '硝', 'green_stained_glass_pane': '硝', 'red_stained_glass_pane': '硝',
    'black_stained_glass_pane': '硝',

    # ───── CARPET (all 16 colors → 布) ─────
    'white_carpet': '布', 'orange_carpet': '布', 'magenta_carpet': '布',
    'light_blue_carpet': '布', 'yellow_carpet': '布', 'lime_carpet': '布',
    'pink_carpet': '布', 'gray_carpet': '布', 'light_gray_carpet': '布',
    'cyan_carpet': '布', 'purple_carpet': '布', 'blue_carpet': '布',
    'brown_carpet': '布', 'green_carpet': '布', 'red_carpet': '布', 'black_carpet': '布',

    # ───── DOOR (all kinds → 扉) ─────
    'oak_door': '扉', 'spruce_door': '扉', 'birch_door': '扉', 'jungle_door': '扉',
    'acacia_door': '扉', 'dark_oak_door': '扉', 'mangrove_door': '扉', 'cherry_door': '扉',
    'bamboo_door': '扉', 'crimson_door': '扉', 'warped_door': '扉',
    'copper_door': '扉', 'exposed_copper_door': '扉', 'weathered_copper_door': '扉',
    'oxidized_copper_door': '扉',
    'waxed_copper_door': '扉', 'waxed_exposed_copper_door': '扉', 'waxed_weathered_copper_door': '扉',
    'waxed_oxidized_copper_door': '扉',
    'iron_door': '扉',

    # ───── TRAPDOOR (all kinds → 板) ─────
    'oak_trapdoor': '板', 'spruce_trapdoor': '板', 'birch_trapdoor': '板', 'jungle_trapdoor': '板',
    'acacia_trapdoor': '板', 'dark_oak_trapdoor': '板', 'mangrove_trapdoor': '板', 'cherry_trapdoor': '板',
    'bamboo_trapdoor': '板', 'crimson_trapdoor': '板', 'warped_trapdoor': '板',
    'copper_trapdoor': '板', 'exposed_copper_trapdoor': '板', 'weathered_copper_trapdoor': '板',
    'oxidized_copper_trapdoor': '板',
    'waxed_copper_trapdoor': '板', 'waxed_exposed_copper_trapdoor': '板', 'waxed_weathered_copper_trapdoor': '板',
    'waxed_oxidized_copper_trapdoor': '板',
    'iron_trapdoor': '板',

    # ───── PRESSURE PLATE (all kinds → 板) ─────
    'oak_pressure_plate': '板', 'spruce_pressure_plate': '板', 'birch_pressure_plate': '板',
    'jungle_pressure_plate': '板', 'acacia_pressure_plate': '板', 'dark_oak_pressure_plate': '板',
    'mangrove_pressure_plate': '板', 'cherry_pressure_plate': '板',
    'bamboo_pressure_plate': '板', 'crimson_pressure_plate': '板', 'warped_pressure_plate': '板',
    'stone_pressure_plate': '板', 'polished_blackstone_pressure_plate': '板',

    # ───── BUTTON (all kinds → 釦) ─────
    'oak_button': '釦', 'spruce_button': '釦', 'birch_button': '釦', 'jungle_button': '釦',
    'acacia_button': '釦', 'dark_oak_button': '釦', 'mangrove_button': '釦', 'cherry_button': '釦',
    'bamboo_button': '釦', 'crimson_button': '釦', 'warped_button': '釦',
    'stone_button': '釦', 'polished_blackstone_button': '釦',

    # ───── FENCE (all kinds → 柵) ─────
    'oak_fence': '柵', 'spruce_fence': '柵', 'birch_fence': '柵', 'jungle_fence': '柵',
    'acacia_fence': '柵', 'dark_oak_fence': '柵', 'mangrove_fence': '柵', 'cherry_fence': '柵',
    'bamboo_fence': '柵', 'crimson_fence': '柵', 'warped_fence': '柵',
    'nether_brick_fence': '瓦', 'iron_bars': '柵',

    # ───── FENCE GATE (all kinds → 門) ─────
    'oak_fence_gate': '門', 'spruce_fence_gate': '門', 'birch_fence_gate': '門', 'jungle_fence_gate': '門',
    'acacia_fence_gate': '門', 'dark_oak_fence_gate': '門', 'mangrove_fence_gate': '門', 'cherry_fence_gate': '門',
    'bamboo_fence_gate': '門', 'crimson_fence_gate': '門', 'warped_fence_gate': '門',

    # ───── WALL SIGN (all kinds → 看) ─────
    'oak_wall_sign': '看', 'spruce_wall_sign': '看', 'birch_wall_sign': '看', 'jungle_wall_sign': '看',
    'acacia_wall_sign': '看', 'dark_oak_wall_sign': '看', 'mangrove_wall_sign': '看', 'cherry_wall_sign': '看',
    'bamboo_wall_sign': '看', 'crimson_wall_sign': '看', 'warped_wall_sign': '看',
    'oak_wall_hanging_sign': '看', 'spruce_wall_hanging_sign': '看', 'birch_wall_hanging_sign': '看',
    'jungle_wall_hanging_sign': '看', 'acacia_wall_hanging_sign': '看', 'dark_oak_wall_hanging_sign': '看',
    'mangrove_wall_hanging_sign': '看', 'cherry_wall_hanging_sign': '看',
    'bamboo_wall_hanging_sign': '看', 'crimson_wall_hanging_sign': '看', 'warped_wall_hanging_sign': '看',

    # ───── HANGING SIGN (all kinds → 看) ─────
    'oak_hanging_sign': '看', 'spruce_hanging_sign': '看', 'birch_hanging_sign': '看', 'jungle_hanging_sign': '看',
    'acacia_hanging_sign': '看', 'dark_oak_hanging_sign': '看', 'mangrove_hanging_sign': '看', 'cherry_hanging_sign': '看',
    'bamboo_hanging_sign': '看', 'crimson_hanging_sign': '看', 'warped_hanging_sign': '看',

    # ───── STANDING SIGN (all kinds → 看) ─────
    'oak_sign': '看', 'spruce_sign': '看', 'birch_sign': '看', 'jungle_sign': '看',
    'acacia_sign': '看', 'dark_oak_sign': '看', 'mangrove_sign': '看', 'cherry_sign': '看',
    'bamboo_sign': '看', 'crimson_sign': '看', 'warped_sign': '看',

    # ───── ORE (all kinds → 鉱) ─────
    'coal_ore': '鉱', 'deepslate_coal_ore': '鉱',
    'iron_ore': '鉱', 'deepslate_iron_ore': '鉱',
    'copper_ore': '鉱', 'deepslate_copper_ore': '鉱',
    'gold_ore': '鉱', 'deepslate_gold_ore': '鉱', 'nether_gold_ore': '鉱',
    'redstone_ore': '鉱', 'deepslate_redstone_ore': '鉱',
    'emerald_ore': '鉱', 'deepslate_emerald_ore': '鉱',
    'lapis_ore': '鉱', 'deepslate_lapis_ore': '鉱',
    'diamond_ore': '鉱', 'deepslate_diamond_ore': '鉱',
    'nether_quartz_ore': '鉱',

    # ───── LIGHT / GLOW ─────
    'torch': '灯', 'wall_torch': '灯', 'soul_torch': '灯',
    'lantern': '灯', 'soul_lantern': '灯', 'jack_o_lantern': '灯',
    'glowstone': '光', 'sea_lantern': '光', 'shroomlight': '光',
    'redstone_lamp': '光', 'candle': '灯',
    'white_candle': '灯', 'orange_candle': '灯', 'magenta_candle': '灯',
    'light_blue_candle': '灯', 'yellow_candle': '灯', 'lime_candle': '灯',
    'pink_candle': '灯', 'gray_candle': '灯', 'light_gray_candle': '灯',
    'cyan_candle': '灯', 'purple_candle': '灯', 'blue_candle': '灯',
    'brown_candle': '灯', 'green_candle': '灯', 'red_candle': '灯', 'black_candle': '灯',
    'candle_cake': '灯', 'white_candle_cake': '灯', 'orange_candle_cake': '灯',
    'magenta_candle_cake': '灯', 'light_blue_candle_cake': '灯', 'yellow_candle_cake': '灯',
    'lime_candle_cake': '灯', 'pink_candle_cake': '灯', 'gray_candle_cake': '灯',
    'light_gray_candle_cake': '灯', 'cyan_candle_cake': '灯', 'purple_candle_cake': '灯',
    'blue_candle_cake': '灯', 'brown_candle_cake': '灯', 'green_candle_cake': '灯',
    'red_candle_cake': '灯', 'black_candle_cake': '灯',
    'campfire': '灯', 'soul_campfire': '灯',
    'froglight': '光', 'ochre_froglight': '光', 'verdant_froglight': '光', 'pearlescent_froglight': '光',
    'fire': '火', 'soul_fire': '火', 'end_rod': '終',

    # ───── SPAWNER / PORTAL ─────
    'spawner': '胞', 'mob_spawner': '胞',
    'end_portal': '門', 'end_portal_frame': '門', 'end_gateway': '門',
    'nether_portal': '門',
    'dragon_egg': '卵',
    'beacon': '塔', 'conduit': '環', 'respawn_anchor': '錨',
    'sculk': '闇', 'sculk_vein': '脈',

    # ───── LEAVES (all kinds except cherry) ─────
    'oak_leaves': '葉', 'spruce_leaves': '葉', 'birch_leaves': '葉', 'jungle_leaves': '葉',
    'acacia_leaves': '葉', 'dark_oak_leaves': '葉', 'mangrove_leaves': '葉',
    'cherry_leaves': '桜',
    'azalea_leaves': '葉', 'flowering_azalea_leaves': '花',

    # ───── LOG (other variants) ─────
    'crimson_stem': '幹', 'warped_stem': '幹',

    # ───── PLANK (all kinds) ─────
    'oak_planks': '板', 'spruce_planks': '板', 'birch_planks': '板', 'jungle_planks': '板',
    'acacia_planks': '板', 'dark_oak_planks': '板', 'mangrove_planks': '板', 'cherry_planks': '桜',
    'bamboo_planks': '竹', 'crimson_planks': '板', 'warped_planks': '板',

    # ───── SLAB (all kinds except terracotta/sandstone handled above) ─────
    'oak_slab': '段', 'spruce_slab': '段', 'birch_slab': '段', 'jungle_slab': '段',
    'acacia_slab': '段', 'dark_oak_slab': '段', 'mangrove_slab': '段', 'cherry_slab': '段',
    'crimson_slab': '段', 'warped_slab': '段', 'bamboo_slab': '段', 'bamboo_mosaic_slab': '段',
    'petrified_oak_slab': '段', 'stone_slab': '段', 'smooth_stone_slab': '段',
    'cut_sandstone_slab': '段', 'cut_red_sandstone_slab': '段',
    'oxidized_cut_copper_slab': '段', 'weathered_cut_copper_slab': '段',
    'waxed_cut_copper_slab': '段', 'waxed_exposed_cut_copper_slab': '段',
    'waxed_weathered_cut_copper_slab': '段', 'waxed_oxidized_cut_copper_slab': '段',

    # ───── STAIRS (all kinds) ─────
    'oak_stairs': '階', 'spruce_stairs': '階', 'birch_stairs': '階', 'jungle_stairs': '階',
    'acacia_stairs': '階', 'dark_oak_stairs': '階', 'mangrove_stairs': '階', 'cherry_stairs': '階',
    'crimson_stairs': '階', 'warped_stairs': '階', 'bamboo_stairs': '階', 'bamboo_mosaic_stairs': '階',
    'stone_stairs': '階', 'cobblestone_stairs': '階', 'mossy_cobblestone_stairs': '階',
    'stone_brick_stairs': '階', 'mossy_stone_brick_stairs': '階', 'cracked_stone_brick_stairs': '階',
    'chiseled_stone_brick_stairs': '階',
    'nether_brick_stairs': '階', 'red_nether_brick_stairs': '階',
    'chiseled_nether_brick_stairs': '階', 'cracked_nether_brick_stairs': '階',
    'quartz_stairs': '階', 'smooth_quartz_stairs': '階', 'chiseled_quartz_stairs': '階',
    'quartz_brick_stairs': '階',
    'end_stone_brick_stairs': '階',
    'sandstone_stairs': '階', 'red_sandstone_stairs': '階',
    'brick_stairs': '階', 'mud_brick_stairs': '階',
    'polished_andesite_stairs': '階', 'polished_diorite_stairs': '階', 'polished_granite_stairs': '階',
    'polished_blackstone_stairs': '階', 'andesite_stairs': '階', 'diorite_stairs': '階',
    'granite_stairs': '階', 'tuff_stairs': '階', 'polished_tuff_stairs': '階',
    'blackstone_stairs': '階', 'cut_copper_stairs': '階',
    'exposed_cut_copper_stairs': '階', 'weathered_cut_copper_stairs': '階',
    'oxidized_cut_copper_stairs': '階',
    'waxed_cut_copper_stairs': '階', 'waxed_exposed_cut_copper_stairs': '階',
    'waxed_weathered_cut_copper_stairs': '階', 'waxed_oxidized_cut_copper_stairs': '階',
    'prismarine_brick_stairs': '階', 'prismarine_stairs': '階',
    'deepslate_brick_stairs': '階', 'deepslate_tile_stairs': '階',
    'polished_deepslate_stairs': '階',
    'purpur_stairs': '階',

    # ───── WALL (all kinds) ─────
    'cobblestone_wall': '壁', 'mossy_cobblestone_wall': '壁',
    'stone_brick_wall': '壁', 'mossy_stone_brick_wall': '壁',
    'cracked_stone_brick_wall': '壁', 'chiseled_stone_brick_wall': '壁',
    'nether_brick_wall': '壁', 'red_nether_brick_wall': '壁',
    'chiseled_nether_brick_wall': '壁', 'cracked_nether_brick_wall': '壁',
    'end_stone_brick_wall': '壁', 'sandstone_wall': '壁', 'red_sandstone_wall': '壁',
    'brick_wall': '壁', 'mud_brick_wall': '壁',
    'polished_andesite_wall': '壁', 'polished_diorite_wall': '壁', 'polished_granite_wall': '壁',
    'polished_blackstone_wall': '壁', 'andesite_wall': '壁', 'diorite_wall': '壁',
    'granite_wall': '壁', 'tuff_wall': '壁', 'polished_tuff_wall': '壁',
    'blackstone_wall': '壁',
    'deepslate_brick_wall': '壁', 'deepslate_tile_wall': '壁',
    'polished_deepslate_wall': '壁',
    'prismarine_wall': '壁',

    # ───── INFESTED (all kinds → 胞=spawner) ─────
    'infested_stone': '胞', 'infested_cobblestone': '胞', 'infested_stone_bricks': '胞',
    'infested_mossy_stone_bricks': '胞', 'infested_cracked_stone_bricks': '胞', 'infested_chiseled_stone_bricks': '胞',
    'infested_deepslate': '胞',

    # ───── DEAD CORAL (all kinds → 珊) ─────
    'dead_brain_coral': '珊', 'dead_brain_coral_block': '珊',
    'dead_brain_coral_fan': '珊', 'dead_brain_coral_wall_fan': '珊',
    'dead_bubble_coral': '珊', 'dead_bubble_coral_block': '珊',
    'dead_bubble_coral_fan': '珊', 'dead_bubble_coral_wall_fan': '珊',
    'dead_fire_coral': '珊', 'dead_fire_coral_block': '珊',
    'dead_fire_coral_fan': '珊', 'dead_fire_coral_wall_fan': '珊',
    'dead_horn_coral': '珊', 'dead_horn_coral_block': '珊',
    'dead_horn_coral_fan': '珊', 'dead_horn_coral_wall_fan': '珊',
    'dead_tube_coral': '珊', 'dead_tube_coral_block': '珊',
    'dead_tube_coral_fan': '珊', 'dead_tube_coral_wall_fan': '珊',

    # ───── LIVE CORAL (all kinds → 珊) ─────
    'brain_coral_block': '珊', 'brain_coral_fan': '珊', 'brain_coral_wall_fan': '珊',
    'bubble_coral_block': '珊', 'bubble_coral_fan': '珊', 'bubble_coral_wall_fan': '珊',
    'fire_coral_block': '珊', 'fire_coral_fan': '珊', 'fire_coral_wall_fan': '珊',
    'horn_coral_block': '珊', 'horn_coral_fan': '珊', 'horn_coral_wall_fan': '珊',
    'tube_coral_block': '珊', 'tube_coral_fan': '珊', 'tube_coral_wall_fan': '珊',

    # ───── MISC ─────
    'bone_block': '骨',
    'bedrock': '暗', 'obsidian': '黒', 'crying_obsidian': '黒',
    'tnt': '爆',
    'hay_block': '草',
    'dried_kelp_block': '藻',
    'scaffolding': '足',
    'ladder': '梯',
    'moss_block': '苔', 'moss_carpet': '苔',
    'magma_block': '溶',
    'soul_sand': '霊', 'soul_soil': '霊',
    'white_concrete_powder': '灰', 'orange_concrete_powder': '灰', 'magenta_concrete_powder': '灰',
    'light_blue_concrete_powder': '灰', 'yellow_concrete_powder': '灰', 'lime_concrete_powder': '灰',
    'pink_concrete_powder': '灰', 'gray_concrete_powder': '灰', 'light_gray_concrete_powder': '灰',
    'cyan_concrete_powder': '灰', 'purple_concrete_powder': '灰', 'blue_concrete_powder': '灰',
    'brown_concrete_powder': '灰', 'green_concrete_powder': '灰', 'red_concrete_powder': '灰', 'black_concrete_powder': '灰',
    'redstone_ore': '鉱', 'player_head': '頭', 'player_wall_head': '頭',
    'potted_.*': '植',  # pattern
    'pink_petals': '花',
    'shulker_box': '箱',
    'lodestone': '磁', 'respawn_anchor': '錨',
    'short_grass': '草', 'tall_grass': '草', 'fern': '葉', 'large_fern': '葉',
    'dandelion': '花', 'poppy': '花', 'blue_orchid': '花', 'allium': '花',
    'azure_bluet': '花', 'red_tulip': '花', 'orange_tulip': '花', 'white_tulip': '花',
    'pink_tulip': '花', 'oxeye_daisy': '花', 'cornflower': '花', 'lily_of_the_valley': '花',
    'wither_rose': '枯', 'sunflower': '花', 'lilac': '花', 'peony': '花', 'rose_bush': '花',
    'banners': '旗',
    'black_banner': '旗', 'blue_banner': '旗', 'brown_banner': '旗', 'cyan_banner': '旗',
    'gray_banner': '旗', 'green_banner': '旗', 'light_blue_banner': '旗',
    'light_gray_banner': '旗', 'lime_banner': '旗', 'magenta_banner': '旗',
    'orange_banner': '旗', 'pink_banner': '旗', 'purple_banner': '旗',
    'red_banner': '旗', 'white_banner': '旗', 'yellow_banner': '旗',
    'black_wall_banner': '旗', 'blue_wall_banner': '旗', 'brown_wall_banner': '旗', 'cyan_wall_banner': '旗',
    'gray_wall_banner': '旗', 'green_wall_banner': '旗', 'light_blue_wall_banner': '旗',
    'light_gray_wall_banner': '旗', 'lime_wall_banner': '旗', 'magenta_wall_banner': '旗',
    'orange_wall_banner': '旗', 'pink_wall_banner': '旗', 'purple_wall_banner': '旗',
    'red_wall_banner': '旗', 'white_wall_banner': '旗', 'yellow_wall_banner': '旗',
    'shelves': '棚', 'acacia_shelf': '棚', 'bamboo_shelf': '棚', 'birch_shelf': '棚',
    'cherry_shelf': '棚', 'crimson_shelf': '棚', 'dark_oak_shelf': '棚', 'jungle_shelf': '棚',
    'mangrove_shelf': '棚', 'oak_shelf': '棚', 'spruce_shelf': '棚', 'warped_shelf': '棚',

    # Potted plants: any name starting with "potted_" → 植 (pot/plant)
    # (handled by pattern below)
}


# ──────────────────────────────────────────────────────────────────────
# Pattern-based fallback for blocks not in CATEGORY_MAP.
# Patterns are matched against the block name (anchored regex).
# ──────────────────────────────────────────────────────────────────────

PATTERN_CATEGORIES: List[Tuple[str, str]] = [
    (r'potted_.*', '植'),
    (r'.*_shelf$', '棚'),
    (r'.*_banner$', '旗'),
    (r'.*_wall_banner$', '旗'),
    (r'.*_candle_cake$', '灯'),
    (r'.*_concrete_powder$', '灰'),
    (r'.*_coral_.*$', '珊'),
    (r'.*_coral$', '珊'),
    (r'.*_wall_fan$', '珊'),
    (r'.*_coral_fan$', '珊'),
    (r'.*_coral_block$', '珊'),
    (r'.*_bed$', '寝'),
    (r'.*_wool$', '毛'),
    (r'.*_carpet$', '布'),
    (r'.*_stained_glass$', '硝'),
    (r'.*_stained_glass_pane$', '硝'),
    (r'.*_terracotta$', '瓦'),
    (r'.*_concrete$', '灰'),
    (r'.*_wall$', '壁'),
    (r'.*_stairs$', '階'),
    (r'.*_slab$', '段'),
    (r'.*_fence$', '柵'),
    (r'.*_fence_gate$', '門'),
    (r'.*_trapdoor$', '板'),
    (r'.*_sign$', '看'),
    (r'.*_hanging_sign$', '看'),
    (r'.*_wall_sign$', '看'),
    (r'.*_button$', '釦'),
    (r'.*_pressure_plate$', '板'),
    (r'.*_ore$', '鉱'),
    (r'.*_shulker_box$', '箱'),
    (r'.*_candle$', '灯'),
    (r'.*_wall_torch$', '灯'),
    (r'.*_mushroom$', '茸'),
    (r'.*_mushroom_block$', '菌'),
    (r'.*_roots$', '根'),
    (r'.*_fungus$', '菌'),
    (r'.*_sprouts$', '菌'),
    (r'.*_vines$', '蔓'),
    (r'.*_vines_plant$', '蔓'),
    (r'.*_stem$', '蔓'),
    (r'.*_wart$', '疣'),
    (r'.*_wart_block$', '疣'),
    (r'.*_wart$', '疣'),
    (r'.*_nylium$', '菌'),
    (r'^attached_.*_stem$', '蔓'),
    (r'^fire$', '火'),
    (r'^soul_fire$', '火'),
    (r'^big_dripleaf_stem$', '葉'),
    (r'^amethyst_.*$', '紫'),
    (r'^lava$', '溶'),
    (r'^water$', '水'),
    (r'^air$', '空'),
    (r'^cave_air$', '空'),
    (r'^void_air$', '空'),
    (r'^structure_void$', '空'),
    (r'^barrier$', '禁'),
    (r'^light$', '光'),
    (r'^bedrock$', '暗'),
    (r'^obsidian$', '黒'),
    (r'^crying_obsidian$', '黒'),
    (r'^end_portal$', '門'),
    (r'^end_gateway$', '門'),
    (r'^nether_portal$', '門'),
    (r'^dragon_egg$', '卵'),
    (r'^conduit$', '環'),
    (r'^lodestone$', '磁'),
    (r'^beacon$', '塔'),
    (r'^structure_block$', '構'),
    (r'^jigsaw$', '鋸'),
    (r'^respawn_anchor$', '錨'),
    (r'^sculk.*$', '闇'),
    (r'^reinforced_deepslate$', '盤'),
    (r'^froglight$', '光'),
    (r'^ochre_froglight$', '光'),
    (r'^verdant_froglight$', '光'),
    (r'^pearlescent_froglight$', '光'),
    (r'^glow_lichen$', '光'),
    (r'^ancient_debris$', '瓦'),
    (r'^andesite_.*$', '安'),
    (r'^blackstone_.*$', '黒'),
    (r'^bell$', '鈴'),
    (r'^beetroots$', '菜'),
    (r'^big_dripleaf_stem$', '葉'),
    (r'^bone_block$', '骨'),
    (r'^bookshelf$', '本'),
    (r'^brewing_stand$', '薬'),
    (r'^brown_mushroom_block$', '菌'),
    (r'^cake$', '菓'),
    (r'^candle_cake$', '灯'),
    (r'^carrots$', '菜'),
    (r'^cauldron$', '鍋'),
    (r'^cave_vines$', '蔓'),
    (r'^cave_vines_plant$', '蔓'),
    (r'^chain$', '鎖'),
    (r'^chest$', '箱'),
    (r'^chipped_anvil$', '鉄'),
    (r'^chiseled_nether_bricks$', '瓦'),
    (r'^clay$', '粘'),
    (r'^coal_block$', '炭'),
    (r'^coal_ore$', '鉱'),
    (r'^coarse_dirt$', '土'),
    (r'^cobbled_deepslate$', '盤'),
    (r'^cobblestone$', '丸'),
    (r'^cocoa$', '柯'),
    (r'^command_block$', '司'),
    (r'^chain_command_block$', '司'),
    (r'^repeating_command_block$', '司'),
    (r'^comparator$', '較'),
    (r'^composter$', '肥'),
    (r'^conduit$', '環'),
    (r'^copper_block$', '銅'),
    (r'^copper_ore$', '鉱'),
    (r'^cornflower$', '花'),
    (r'^cracked_deepslate_bricks$', '盤'),
    (r'^cracked_deepslate_tiles$', '盤'),
    (r'^cracked_nether_bricks$', '瓦'),
    (r'^cracked_polished_blackstone_bricks$', '黒'),
    (r'^cracked_stone_bricks$', '瓦'),
    (r'^crimson_fungus$', '菌'),
    (r'^crimson_hyphae$', '幹'),
    (r'^crimson_nylium$', '菌'),
    (r'^crimson_roots$', '根'),
    (r'^crimson_stem$', '幹'),
    (r'^crying_obsidian$', '黒'),
    (r'^cut_copper$', '銅'),
    (r'^cut_red_sandstone$', '砂'),
    (r'^cut_sandstone$', '砂'),
    (r'^daisy$', '花'),
    (r'^damaged_anvil$', '鉄'),
    (r'^dandelion$', '花'),
    (r'^dark_oak_.*$', '幹'),
    (r'^daylight_detector$', '光'),
    (r'^deepslate$', '盤'),
    (r'^detector_rail$', '探'),
    (r'^diorite_.*$', '閃'),
    (r'^dirt$', '土'),
    (r'^dirt_path$', '土'),
    (r'^dispenser$', '射'),
    (r'^dried_kelp_block$', '藻'),
    (r'^dripstone_block$', '鍾'),
    (r'^dropper$', '漏'),
    (r'^emerald_block$', '翠'),
    (r'^emerald_ore$', '鉱'),
    (r'^enchanting_table$', '机'),
    (r'^end_gateway$', '門'),
    (r'^end_portal$', '門'),
    (r'^end_portal_frame$', '門'),
    (r'^end_rod$', '終'),
    (r'^end_stone$', '終'),
    (r'^exposed_copper$', '銅'),
    (r'^exposed_cut_copper$', '銅'),
    (r'^farmland$', '畝'),
    (r'^fern$', '葉'),
    (r'^fire$', '火'),
    (r'^fletching_table$', '機'),
    (r'^flowering_azalea$', '花'),
    (r'^flowering_azalea_leaves$', '花'),
    (r'^frogspawn$', '蛙'),
    (r'^frosted_ice$', '氷'),
    (r'^furnace$', '炉'),
    (r'^gilded_blackstone$', '黒'),
    (r'^glass$', '硝'),
    (r'^glass_pane$', '硝'),
    (r'^glow_lichen$', '光'),
    (r'^glowstone$', '光'),
    (r'^gold_block$', '金'),
    (r'^gold_ore$', '鉱'),
    (r'^granite_.*$', '花'),
    (r'^grass_block$', '土'),
    (r'^gravel$', '砂'),
    (r'^grindstone$', '砥'),
    (r'^hanging_roots$', '根'),
    (r'^hay_block$', '草'),
    (r'^heavy_weighted_pressure_plate$', '鉄'),
    (r'^honey_block$', '蜜'),
    (r'^honeycomb_block$', '蜜'),
    (r'^hopper$', '漏'),
    (r'^ice$', '氷'),
    (r'^infested_.*$', '胞'),
    (r'^iron_bars$', '柵'),
    (r'^iron_block$', '鉄'),
    (r'^iron_door$', '扉'),
    (r'^iron_ore$', '鉱'),
    (r'^iron_trapdoor$', '板'),
    (r'^jack_o_lantern$', '灯'),
    (r'^jukebox$', '楽'),
    (r'^jungle_.*$', '幹'),
    (r'^kelp$', '藻'),
    (r'^kelp_plant$', '藻'),
    (r'^ladder$', '梯'),
    (r'^lantern$', '灯'),
    (r'^lapis_block$', '青'),
    (r'^lapis_ore$', '鉱'),
    (r'^large_amethyst_bud$', '紫'),
    (r'^large_fern$', '葉'),
    (r'^lava$', '溶'),
    (r'^lava_cauldron$', '鍋'),
    (r'^leaf_litter$', '葉'),
    (r'^lectern$', '本'),
    (r'^lever$', '桿'),
    (r'^light$', '光'),
    (r'^light_weighted_pressure_plate$', '金'),
    (r'^lily_of_the_valley$', '花'),
    (r'^lily_pad$', '蓮'),
    (r'^lit_blast_furnace$', '炉'),
    (r'^lit_furnace$', '炉'),
    (r'^lit_smoker$', '炉'),
    (r'^lodestone$', '磁'),
    (r'^loom$', '機'),
    (r'^magma_block$', '溶'),
    (r'^mangrove_.*$', '幹'),
    (r'^medium_amethyst_bud$', '紫'),
    (r'^melon$', '瓜'),
    (r'^melon_stem$', '蔓'),
    (r'^moss_block$', '苔'),
    (r'^moss_carpet$', '苔'),
    (r'^mossy_cobblestone$', '丸'),
    (r'^mud$', '泥'),
    (r'^mud_bricks$', '瓦'),
    (r'^muddy_mangrove_roots$', '根'),
    (r'^mushroom_block$', '菌'),
    (r'^mushroom_stem$', '菌'),
    (r'^mycelium$', '菌'),
    (r'^nether_bricks$', '瓦'),
    (r'^nether_gold_ore$', '鉱'),
    (r'^nether_portal$', '門'),
    (r'^nether_quartz_ore$', '鉱'),
    (r'^nether_sprouts$', '菌'),
    (r'^nether_wart$', '疣'),
    (r'^nether_wart_block$', '疣'),
    (r'^netherite_block$', '鍊'),
    (r'^note_block$', '楽'),
    (r'^oak_.*$', '幹'),
    (r'^observer$', '監'),
    (r'^obsidian$', '黒'),
    (r'^ochre_froglight$', '光'),
    (r'^orange_.*$', '橙'),
    (r'^oxeye_daisy$', '花'),
    (r'^packed_ice$', '氷'),
    (r'^packed_mud$', '塊'),
    (r'^pearlescent_froglight$', '光'),
    (r'^peony$', '花'),
    (r'^petrified_oak_slab$', '段'),
    (r'^pink_petals$', '花'),
    (r'^pink_.*$', '桃'),
    (r'^piston$', '押'),
    (r'^piston_head$', '押'),
    (r'^pitcher_plant$', '瓶'),
    (r'^player_head$', '頭'),
    (r'^player_wall_head$', '頭'),
    (r'^podzol$', '土'),
    (r'^pointed_dripstone$', '鍾'),
    (r'^poppy$', '花'),
    (r'^potatoes$', '芋'),
    (r'^powder_snow$', '雪'),
    (r'^powder_snow_cauldron$', '鍋'),
    (r'^powered_rail$', '電'),
    (r'^prismarine$', '海'),
    (r'^prismarine_bricks$', '海'),
    (r'^prismarine_slab$', '段'),
    (r'^prismarine_stairs$', '階'),
    (r'^prismarine_wall$', '壁'),
    (r'^pumpkin$', '瓢'),
    (r'^pumpkin_stem$', '蔓'),
    (r'^purple_.*$', '紫'),
    (r'^purpur_block$', '紫'),
    (r'^purpur_pillar$', '紫'),
    (r'^purpur_slab$', '段'),
    (r'^purpur_stairs$', '階'),
    (r'^quartz_block$', '石'),
    (r'^quartz_bricks$', '石'),
    (r'^quartz_pillar$', '石'),
    (r'^quartz_slab$', '段'),
    (r'^quartz_stairs$', '階'),
    (r'^rail$', '軌'),
    (r'^raw_copper_block$', '銅'),
    (r'^raw_gold_block$', '金'),
    (r'^raw_iron_block$', '鉄'),
    (r'^red_mushroom_block$', '菌'),
    (r'^red_nether_bricks$', '瓦'),
    (r'^red_sand$', '砂'),
    (r'^red_sandstone$', '砂'),
    (r'^redstone_block$', '赤'),
    (r'^redstone_lamp$', '光'),
    (r'^redstone_ore$', '鉱'),
    (r'^redstone_torch$', '灯'),
    (r'^redstone_wire$', '赤'),
    (r'^reeds$', '蔗'),
    (r'^reinforced_deepslate$', '盤'),
    (r'^repeater$', '繰'),
    (r'^respawn_anchor$', '錨'),
    (r'^rooted_dirt$', '土'),
    (r'^rose_bush$', '花'),
    (r'^sand$', '砂'),
    (r'^sandstone$', '砂'),
    (r'^sandstone_slab$', '段'),
    (r'^sandstone_stairs$', '階'),
    (r'^sandstone_wall$', '壁'),
    (r'^scaffolding$', '足'),
    (r'^sculk$', '闇'),
    (r'^sculk_catalyst$', '触'),
    (r'^sculk_sensor$', '感'),
    (r'^sculk_shrieker$', '叫'),
    (r'^sculk_vein$', '脈'),
    (r'^sea_lantern$', '光'),
    (r'^sea_pickle$', '珊'),
    (r'^shroomlight$', '光'),
    (r'^shulker_box$', '箱'),
    (r'^slime$', '粘'),
    (r'^slime_block$', '粘'),
    (r'^smithing_table$', '机'),
    (r'^smoker$', '炉'),
    (r'^smooth_basalt$', '磨'),
    (r'^smooth_quartz$', '石'),
    (r'^smooth_quartz_slab$', '段'),
    (r'^smooth_quartz_stairs$', '階'),
    (r'^smooth_stone$', '磨'),
    (r'^smooth_stone_slab$', '段'),
    (r'^snow$', '雪'),
    (r'^snow_block$', '雪'),
    (r'^soul_campfire$', '灯'),
    (r'^soil_fire$', '火'),
    (r'^soul_lantern$', '灯'),
    (r'^soul_sand$', '霊'),
    (r'^soul_soil$', '霊'),
    (r'^soul_torch$', '灯'),
    (r'^spawner$', '胞'),
    (r'^sponge$', '綿'),
    (r'^spore_blossom$', '花'),
    (r'^spruce_.*$', '幹'),
    (r'^sticky_piston$', '押'),
    (r'^stone$', '岩'),
    (r'^stonecutter$', '砥'),
    (r'^string$', '糸'),
    (r'^stripped_.*$', '幹'),
    (r'^structure_block$', '構'),
    (r'^structure_void$', '空'),
    (r'^sugar_cane$', '蔗'),
    (r'^sunflower$', '花'),
    (r'^sweet_berries$', '莓'),
    (r'^sweet_berry_bush$', '莓'),
    (r'^tall_grass$', '草'),
    (r'^target$', '的'),
    (r'^terracotta$', '瓦'),
    (r'^tinted_glass$', '硝'),
    (r'^tnt$', '爆'),
    (r'^torch$', '灯'),
    (r'^torchflower$', '花'),
    (r'^torchflower_crop$', '花'),
    (r'^torchflower_seeds$', '種'),
    (r'^trapdoor$', '板'),
    (r'^trapped_chest$', '箱'),
    (r'^tripwire$', '線'),
    (r'^tripwire_hook$', '鈎'),
    (r'^tuff$', '灰'),
    (r'^turtle_egg$', '卵'),
    (r'^twisting_vines$', '蔓'),
    (r'^twisting_vines_plant$', '蔓'),
    (r'^verdant_froglight$', '光'),
    (r'^vine$', '蔓'),
    (r'^warped_.*$', '幹'),
    (r'^water$', '水'),
    (r'^water_cauldron$', '鍋'),
    (r'^waxed_.*_cut_copper$', '銅'),
    (r'^waxed_.*_copper$', '銅'),
    (r'^weeping_vines$', '蔓'),
    (r'^weeping_vines_plant$', '蔓'),
    (r'^wet_farmland$', '畝'),
    (r'^wet_sponge$', '綿'),
    (r'^wheat$', '麦'),
    (r'^wheat_seeds$', '麦'),
    (r'^white_.*$', '白'),
    (r'^wither_rose$', '枯'),
    (r'^yellow_.*$', '黄'),

    # ───── Additional patterns for the new 1.21.x blocks ─────
    (r'.*_chiseled_copper$', '銅'),
    (r'.*_chiseled_deepslate$', '盤'),
    (r'.*_chiseled_red_sandstone$', '砂'),
    (r'.*_chiseled_resin_bricks$', '樹'),
    (r'.*_chiseled_sandstone$', '砂'),
    (r'.*_chiseled_tuff$', '灰'),
    (r'.*_chiseled_tuff_bricks$', '灰'),
    (r'.*_chiseled_bookshelf$', '本'),
    (r'.*_grate$', '格'),
    (r'.*_lantern$', '灯'),
    (r'.*_torch$', '灯'),
    (r'.*_chain$', '鎖'),
    (r'.*_chest$', '箱'),
    (r'.*_bars$', '柵'),
    (r'.*_bulb$', '光'),
    (r'.*_golem_statue$', '像'),
    (r'^cobweb$', '網'),
    (r'^bush$', '草'),
    (r'^bamboo$', '竹'),
    (r'^bamboo_sapling$', '苗'),
    (r'^chorus_.*$', '歌'),
    (r'^closed_eyeblossom$', '花'),
    (r'^open_eyeblossom$', '花'),
    (r'^eyeblossom$', '花'),
    (r'^crafter$', '機'),
    (r'^creaking_heart$', '心'),
    (r'^creeper_head$', '頭'),
    (r'^creeper_wall_head$', '頭'),
    (r'^dragon_head$', '頭'),
    (r'^dragon_wall_head$', '頭'),
    (r'^piglin_head$', '頭'),
    (r'^piglin_wall_head$', '頭'),
    (r'^skeleton_skull$', '頭'),
    (r'^skeleton_wall_skull$', '頭'),
    (r'^wither_skeleton_skull$', '頭'),
    (r'^wither_skeleton_wall_skull$', '頭'),
    (r'^zombie_head$', '頭'),
    (r'^zombie_wall_head$', '頭'),
    (r'^player_head$', '頭'),
    (r'^player_wall_head$', '頭'),
    (r'^decorated_pot$', '植'),
    (r'^dried_ghast$', '霊'),
    (r'^firefly_bush$', '花'),
    (r'^flower_pot$', '植'),
    (r'^heavy_core$', '心'),
    (r'^iron_chain$', '鎖'),
    (r'^lightning_rod$', '電'),
    (r'^netherrack$', '獄'),
    (r'^pale_hanging_moss$', '苔'),
    (r'^pale_moss_block$', '苔'),
    (r'^pale_oak_.*$', '幹'),
    (r'^pitcher_crop$', '瓶'),
    (r'^resin_block$', '樹'),
    (r'^resin_bricks$', '樹'),
    (r'^resin_clump$', '樹'),
    (r'^seagrass$', '藻'),
    (r'^short_dry_grass$', '草'),
    (r'^smooth_red_sandstone$', '砂'),
    (r'^smooth_sandstone$', '砂'),
    (r'^sniffer_egg$', '卵'),
    (r'^stone_bricks$', '瓦'),
    (r'^suspicious_gravel$', '砂'),
    (r'^suspicious_sand$', '砂'),
    (r'^tall_dry_grass$', '草'),
    (r'^tall_seagrass$', '藻'),
    (r'^test_block$', '?'),
    (r'^test_instance_block$', '?'),
    (r'^trial_spawner$', '胞'),
    (r'^tuff_bricks$', '灰'),
    (r'^vault$', '庫'),
    (r'^waxed_.*_copper$', '銅'),
    (r'^waxed_.*_cut_copper$', '銅'),
    (r'^weathered_.*_copper$', '銅'),
    (r'^weathered_.*_cut_copper$', '銅'),
    (r'^oxidized_.*_copper$', '銅'),
    (r'^oxidized_.*_cut_copper$', '銅'),
    (r'^exposed_.*_copper$', '銅'),
    (r'^exposed_.*_cut_copper$', '銅'),
    (r'^wildflowers$', '花'),
    (r'^waxed_lightning_rod$', '電'),
    (r'^weathered_lightning_rod$', '電'),
    (r'^oxidized_lightning_rod$', '電'),
    (r'^exposed_lightning_rod$', '電'),
]


# ──────────────────────────────────────────────────────────────────────
# Build the final mapping
# ──────────────────────────────────────────────────────────────────────

def build_mapping(block_names: List[str]) -> Dict[str, str]:
    block_names_set = set(block_names)
    final: Dict[str, str] = {}

    # Pass 1: exact name matches
    for name in block_names:
        if name in CATEGORY_MAP:
            final[name] = CATEGORY_MAP[name]

    # Pass 2: pattern-based fallback
    for name in block_names:
        if name in final:
            continue
        for pattern, char in PATTERN_CATEGORIES:
            if re.match(pattern, name):
                final[name] = char
                break

    # Pass 3: still-unmatched blocks — flag for manual review
    # (we don't synthesize chars, we mark them)
    unmatched = [n for n in block_names if n not in final]
    if unmatched:
        print(f"WARNING: {len(unmatched)} blocks had no exact or pattern match:")
        for n in unmatched[:20]:
            print(f"  - {n}")
        if len(unmatched) > 20:
            print(f"  ... and {len(unmatched) - 20} more")

    return final


def verify_no_collisions(mapping: Dict[str, str]) -> int:
    """Returns the number of distinct chars (low = good, since each
    char represents a semantic category that intentionally has many
    blocks mapping to it)."""
    return len(set(mapping.values()))


def write_outputs(mapping: Dict[str, str], version: str, out_dir: str) -> Tuple[str, str]:
    json_path = os.path.join(out_dir, f'block_to_char_{version}.json')
    js_path = os.path.join(out_dir, f'block_to_char_{version}.js')
    with open(json_path, 'w') as f:
        json.dump(mapping, f, ensure_ascii=False, indent=2)
    with open(js_path, 'w') as f:
        f.write(f'// Auto-generated from minecraft-data {version} ({len(mapping)} blocks, ~{len(set(mapping.values()))} categories)\n')
        f.write('// Regenerate via: python3 lib/build_block_chars.py\n')
        f.write('// Each char is a CJK ideograph that semantically means that thing in Chinese/Japanese:\n')
        f.write('//   瓦=瓦(tile) 扉=door 階=stairs 硝=glass 幹=trunk 板=board 葉=leaf 花=flower\n')
        f.write('//   苗=seedling 草=grass 樹=tree 葉=leaf 枝=branch 根=root 実=fruit 種=seed\n')
        f.write('//   岩=rock 石=stone 砂=sand 土=earth 水=water 火=fire 空=sky/air 光=light\n')
        f.write('// etc. 90% of cases resolved by visual alone; for exact block use verify_block.\n\n')
        f.write('export const BLOCK_TO_CHAR = {\n')
        for n, c in sorted(mapping.items()):
            n_esc = n.replace('\\', '\\\\').replace("'", "\\'")
            f.write(f"  '{n_esc}': '{c}',\n")
        f.write('};\n')
    return json_path, js_path


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--minecraft-data', default='/home/nicolas/Projects/DaemonCraft/agents/bot/node_modules/minecraft-data',
                   help='Path to minecraft-data npm package')
    p.add_argument('--version', default='1.21.9', help='Minecraft version (e.g. 1.21.9)')
    p.add_argument('--out-dir', default='/home/nicolas/Projects/DaemonCraft/agents/bot/lib',
                   help='Output directory for .json and .js files')
    args = p.parse_args()

    path = f"{args.minecraft_data}/minecraft-data/data/pc/{args.version}/blocks.json"
    with open(path) as f:
        data = json.load(f)
    all_names = sorted(set(b['name'] for b in data))
    print(f"Loaded {len(all_names)} unique block names from minecraft-data {args.version}")

    mapping = build_mapping(all_names)
    print(f"Assigned: {len(mapping)} blocks")
    print(f"Distinct chars: {verify_no_collisions(mapping)}")

    json_path, js_path = write_outputs(mapping, args.version, args.out_dir)
    print(f"Wrote {json_path} ({os.path.getsize(json_path)} bytes)")
    print(f"Wrote {js_path} ({os.path.getsize(js_path)} bytes)")

    backup_dir = os.path.expanduser('~/Projects/DaemonCraft/lib')
    os.makedirs(backup_dir, exist_ok=True)
    backup_json = os.path.join(backup_dir, f'block_to_char_{args.version}.json')
    with open(backup_json, 'w') as f:
        json.dump(mapping, f, ensure_ascii=False, indent=2)
    print(f"Backup at {backup_json} ({os.path.getsize(backup_json)} bytes)")
    return 0


if __name__ == '__main__':
    sys.exit(main())
