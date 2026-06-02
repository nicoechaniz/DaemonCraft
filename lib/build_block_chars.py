#!/usr/bin/env python3
"""
build_block_chars.py — Generate the no-collision block→char mapping for mBit visual format.

Regenerates:
  ~/Projects/DaemonCraft/lib/block_to_char_<version>.json
  ~/Projects/DaemonCraft/agents/bot/lib/block_to_char_<version>.js

Run after bumping the Minecraft data version. The mapping covers every
unique block name in minecraft-data for the configured version.

Mnemonic chars (super-common blocks, same char across similar names):
  ' ' = air, cave_air, void_air
  '~' = water
  '!' = lava
  ',' = short_grass
  ';' = tall_grass
  '†' = torch, wall_torch, soul_torch
  '◊' = lantern, soul_lantern
  'R' = redstone_wire
  'r' = redstone_torch

Category chars (all blocks of a category share one char, distinct across categories):
  '◫' = all 21 door types
  '◰' = chest, trapped_chest, ender_chest
  '⊡' = furnace, blast_furnace, smoker, lit variants
  '⊞' = crafting_table, cartography_table, smithing_table, fletching_table, loom
  '⊏' = all 16 bed types
  '▢' = all 18 glass types

Rest: unique CJK Unified Ideographs (U+4E00+) assigned alphabetically.
0 collisions between distinct categories. Yellow_terracotta != brown_terracotta
!= orange_terracotta != red_terracotta.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Callable, Iterable


MNEMONIC = {
    'air': ' ', 'cave_air': ' ', 'void_air': ' ',
    'water': '~', 'lava': '!',
    'short_grass': ',', 'tall_grass': ';',
    'redstone_wire': 'R', 'redstone_torch': 'r',
    'torch': '†', 'wall_torch': '†', 'soul_torch': '†',
    'lantern': '◊', 'soul_lantern': '◊',
}

CATEGORIES: dict[str, tuple[str, Callable[[str], bool]]] = {
    'door':      ('◫', lambda n: n.endswith('_door')),
    'chest':     ('◰', lambda n: n in ('chest', 'trapped_chest', 'ender_chest')),
    'furnace':   ('⊡', lambda n: n in ('furnace', 'blast_furnace', 'smoker',
                                          'lit_furnace', 'lit_blast_furnace', 'lit_smoker')),
    'crafting':  ('⊞', lambda n: n in ('crafting_table', 'cartography_table',
                                          'smithing_table', 'fletching_table', 'loom')),
    'bed':       ('⊏', lambda n: n.endswith('_bed')),
    'glass':     ('▢', lambda n: ('glass' in n and 'pane' not in n) or n == 'glass'),
}

POOL_START = 0x4E00  # CJK Unified Ideographs
POOL_END = 0x9FFF
POOL_SIZE = POOL_END - POOL_START + 1


def load_block_names(minecraft_data_root: str, version: str) -> list[str]:
    path = f"{minecraft_data_root}/minecraft-data/data/pc/{version}/blocks.json"
    with open(path) as f:
        data = json.load(f)
    return sorted(set(b['name'] for b in data))


def build_mapping(block_names: Iterable[str]) -> dict[str, str]:
    block_names = set(block_names)
    assigned: dict[str, str] = {}
    used_chars: set[str] = set()

    # 1) Mnemonics
    for n, c in MNEMONIC.items():
        if n in block_names:
            assigned[n] = c
            used_chars.add(c)

    # 2) Categories (each gets one char, distinct across categories)
    for _cat_name, (char, predicate) in CATEGORIES.items():
        if char in used_chars:
            raise RuntimeError(f"Category char {char!r} already used")
        for n in block_names:
            if predicate(n) and n not in assigned:
                assigned[n] = char
        used_chars.add(char)

    # 3) Rest, alphabetical, sequential CJK pool
    remaining = sorted(n for n in block_names if n not in assigned)
    next_idx = 0
    for n in remaining:
        while chr(POOL_START + next_idx) in used_chars:
            next_idx += 1
        if next_idx >= POOL_SIZE:
            raise RuntimeError(f"CJK pool exhausted at block {n!r}")
        c = chr(POOL_START + next_idx)
        assigned[n] = c
        used_chars.add(c)
        next_idx += 1

    return assigned


def verify_zero_collisions(assigned: dict[str, str], block_names: list[str]) -> None:
    char_to_names: dict[str, list[str]] = {}
    for n in block_names:
        if n in assigned:
            char_to_names.setdefault(assigned[n], []).append(n)

    category_chars = {c for c, _ in CATEGORIES.values()}
    mnemonic_chars = set(MNEMONIC.values())
    allowed_multi = category_chars | mnemonic_chars

    violations: list[str] = []
    for c, names in char_to_names.items():
        if c in allowed_multi:
            continue
        if len(names) > 1:
            violations.append(f"  {c!r} ({names[0]!r}+{len(names)-1} more): {names[:5]}")
    if violations:
        msg = "Collisions detected in CJK assignments:\n" + "\n".join(violations)
        raise RuntimeError(msg)

    unassigned = [n for n in block_names if n not in assigned]
    if unassigned:
        raise RuntimeError(f"Unassigned blocks: {unassigned[:5]}... ({len(unassigned)} total)")

    total = len(assigned)
    cjk_used = sum(1 for n in assigned if POOL_START <= ord(assigned[n]) <= POOL_END)
    print(f"OK: {total} blocks assigned, {cjk_used} unique CJK, "
          f"{sum(1 for n in assigned if assigned[n] in category_chars)} in category chars, "
          f"{sum(1 for n in assigned if assigned[n] in mnemonic_chars)} in mnemonic chars")


def write_outputs(assigned: dict[str, str], version: str, out_dir: str) -> tuple[str, str]:
    json_path = os.path.join(out_dir, f'block_to_char_{version}.json')
    js_path = os.path.join(out_dir, f'block_to_char_{version}.js')
    with open(json_path, 'w') as f:
        json.dump(assigned, f, ensure_ascii=False, indent=2)
    with open(js_path, 'w') as f:
        f.write(f'// Auto-generated from minecraft-data {version} ({len(assigned)} blocks, 0 collisions)\n')
        f.write('// Regenerate via: python3 lib/build_block_chars.py\n')
        f.write('// Pool: CJK Unified Ideographs (U+4E00-U+9FFF), starts after category chars.\n')
        f.write('\n')
        f.write('export const BLOCK_TO_CHAR = {\n')
        for n, c in assigned.items():
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

    block_names = load_block_names(args.minecraft_data, args.version)
    print(f"Loaded {len(block_names)} unique block names from minecraft-data {args.version}")
    assigned = build_mapping(block_names)
    verify_zero_collisions(assigned, block_names)
    json_path, js_path = write_outputs(assigned, args.version, args.out_dir)
    print(f"Wrote {json_path} ({os.path.getsize(json_path)} bytes)")
    print(f"Wrote {js_path} ({os.path.getsize(js_path)} bytes)")

    # Also write to the canonical ~/Projects/DaemonCraft/lib/ for backup
    backup_dir = os.path.expanduser('~/Projects/DaemonCraft/lib')
    os.makedirs(backup_dir, exist_ok=True)
    backup_json = os.path.join(backup_dir, f'block_to_char_{args.version}.json')
    with open(backup_json, 'w') as f:
        json.dump(assigned, f, ensure_ascii=False, indent=2)
    print(f"Backup at {backup_json} ({os.path.getsize(backup_json)} bytes)")
    return 0


if __name__ == '__main__':
    sys.exit(main())
