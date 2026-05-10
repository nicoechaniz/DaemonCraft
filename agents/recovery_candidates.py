#!/usr/bin/env python3
"""Deterministic recovery-candidate synthesis for the autonomous loop.

Codex audit (2026-05-10) of lessons-007/008 contrast: the body model
gemma-andy:e4b-v2-2-3-q8_0 is good at SELECTION (lesson 7: 9-10/10 when
given an explicit substitute) but bad at SEARCH (lesson 8: 0-2/5 when
asked to invent a substitute from a negation). Experiment 009 confirmed
the diagnosis (20/20 substitute-match when intent names the alternative).

This module synthesises substitutes deterministically from world state,
producing a rewritten intent the body model can execute via SELECTION.
It runs at the autonomous loop's per-step retry layer (between
verify_step failure and step.retries++).

Pure-Python, no I/O. World state is passed in by the caller."""
from __future__ import annotations

import re
from typing import Optional


# Failure-detail patterns derived from bot/server.js error messages
# (see place(), mine_block(), etc. throw sites).
_OCCUPIED_RE = re.compile(
    r"target space is occupied by (\w+)", re.IGNORECASE)
_NO_NEIGHBOR_RE = re.compile(
    r"no solid adjacent block", re.IGNORECASE)
_BOT_SELF_RE = re.compile(
    r"bot is currently standing at|cannot place a block in the space it occupies",
    re.IGNORECASE)
_MISSING_INV_RE = re.compile(
    r"no (\w+) in inventory", re.IGNORECASE)
_COORD_IN_INTENT_RE = re.compile(
    r"\((-?\d+),\s*(-?\d+),\s*(-?\d+)\)")


def _parse_first_coord(intent: str) -> Optional[tuple[int, int, int]]:
    """Extract the first (x, y, z) coord from an intent string."""
    m = _COORD_IN_INTENT_RE.search(intent)
    if not m:
        return None
    return (int(m.group(1)), int(m.group(2)), int(m.group(3)))


def _is_air(block_name: str) -> bool:
    return block_name.lower() in {"air", "cave_air", "void_air"}


def _block_at(blocks: list, x: int, y: int, z: int) -> Optional[dict]:
    for b in blocks:
        if b.get("x") == x and b.get("y") == y and b.get("z") == z:
            return b
    return None


def _find_air_with_neighbor(blocks: list, around: tuple[int, int, int],
                            radius: int = 2) -> Optional[tuple[int, int, int]]:
    """Find an air voxel near `around` that has at least one solid face-adjacent block.

    Iterates a small cube (radius x radius x 3 in y) around the failed coord.
    A voxel qualifies if (a) it is air or absent from `blocks` and (b) at
    least one face-adjacent voxel in `blocks` is non-air. Returns the
    closest qualifying voxel by Manhattan distance.
    """
    cx, cy, cz = around
    candidates = []  # (explicitly_air_rank, manhattan, (x,y,z))
    for dx in range(-radius, radius + 1):
        for dz in range(-radius, radius + 1):
            for dy in (0, 1, -1):
                if dx == 0 and dy == 0 and dz == 0:
                    continue  # the failing coord itself
                x, y, z = cx + dx, cy + dy, cz + dz
                target = _block_at(blocks, x, y, z)
                # Target must be air (or absent — treat absent as not-known-occupied)
                if target and not _is_air(target.get("name", "")):
                    continue
                explicitly_air = 0 if (target and _is_air(target.get("name", ""))) else 1
                # Need at least one solid face-adjacent block
                for nx, ny, nz in ((x+1, y, z), (x-1, y, z), (x, y+1, z),
                                   (x, y-1, z), (x, y, z+1), (x, y, z-1)):
                    n = _block_at(blocks, nx, ny, nz)
                    if n and not _is_air(n.get("name", "")):
                        manhattan = abs(dx) + abs(dy) + abs(dz)
                        candidates.append((explicitly_air, manhattan, (x, y, z)))
                        break
    if not candidates:
        return None
    candidates.sort(key=lambda c: (c[0], c[1]))
    return candidates[0][2]


def _placement_substitutes_in_inventory(inv: dict, original_block: str) -> Optional[str]:
    """If the original block isn't in inventory, find a placeable alternative we DO have.

    Iterates a fixed list of common placeable blocks in priority order and
    returns the first that has a positive inventory count.
    """
    held_blocks = ["oak_planks", "cobblestone", "dirt", "stone", "oak_log",
                   "spruce_planks", "birch_planks"]
    for b in held_blocks:
        if b == original_block.lower():
            continue
        for k, v in inv.items():
            if isinstance(k, str) and k.lower() == b and isinstance(v, (int, float)) and v > 0:
                return b
    return None


def maybe_synthesize_substitute(step, embodied_result: dict, *,
                                bot_position: tuple[int, int, int],
                                nearby_blocks: Optional[list] = None,
                                inventory: Optional[dict] = None) -> Optional[str]:
    """Return a rewritten intent string with an explicit substitute, or None.

    Args:
        step: a Step-like object with .intent attribute (string).
        embodied_result: response dict from POST /intent.
        bot_position: bot's current (x, y, z) integer block coords.
        nearby_blocks: list of {x, y, z, name} dicts from bot REST /nearby.
        inventory: dict mapping item name → count from bot REST /inventory.

    Returns None when:
      - embodied_result is OK (no failure to recover from)
      - failure details don't match any known subtype
      - we can't find a feasible candidate in the world state
    """
    if embodied_result.get("ok") is True:
        return None
    exec_results = embodied_result.get("execution_results") or []
    if not exec_results:
        return None
    failure = exec_results[0]
    if failure.get("ok") is True:
        return None
    details = failure.get("details") or ""
    if not details:
        return None

    nearby_blocks = nearby_blocks or []
    inventory = inventory or {}
    failed_coord = _parse_first_coord(step.intent)

    # Subtype: missing inventory item
    m = _MISSING_INV_RE.search(details)
    if m:
        original_block = m.group(1).lower()
        sub_block = _placement_substitutes_in_inventory(inventory, original_block)
        if sub_block and failed_coord:
            x, y, z = failed_coord
            return (f"Place 1 {sub_block} at coordinates ({x}, {y}, {z}) — "
                    f"the original {original_block} is not in inventory; we have {sub_block}.")
        return None

    # Subtype: bot self-position (target equals bot's current position)
    if _BOT_SELF_RE.search(details):
        if not failed_coord:
            return None
        # Pick a horizontal neighbor that's air with a solid block below
        for dx, dz in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            cx, cy, cz = failed_coord[0] + dx, failed_coord[1], failed_coord[2] + dz
            target = _block_at(nearby_blocks, cx, cy, cz)
            below = _block_at(nearby_blocks, cx, cy - 1, cz)
            target_air = target is None or _is_air(target.get("name", ""))
            below_solid = below and not _is_air(below.get("name", ""))
            if target_air and below_solid:
                return (f"Place 1 oak_planks at coordinates ({cx}, {cy}, {cz}) — "
                        f"the failing target was the bot's own position.")
        return None

    # Subtype: target occupied
    occ_match = _OCCUPIED_RE.search(details)
    if occ_match and failed_coord:
        sub = _find_air_with_neighbor(nearby_blocks, failed_coord, radius=2)
        if sub:
            x, y, z = sub
            return (f"Place 1 oak_planks at coordinates ({x}, {y}, {z}) — "
                    f"the original target was occupied by {occ_match.group(1)}.")
        return None

    # Subtype: no solid neighbor
    if _NO_NEIGHBOR_RE.search(details) and failed_coord:
        # Find the highest solid-y at the target column; if any, suggest building up from there
        x, _y, z = failed_coord
        column_solids = [b for b in nearby_blocks
                        if b.get("x") == x and b.get("z") == z
                        and not _is_air(b.get("name", ""))]
        if column_solids:
            top = max(column_solids, key=lambda b: b.get("y", 0))
            support_y = top["y"] + 1
            return (f"Step 1: Place 1 oak_planks at coordinates ({x}, {support_y}, {z}) "
                    f"first as a support block. Step 2: Place 1 oak_planks at "
                    f"({failed_coord[0]}, {failed_coord[1]}, {failed_coord[2]}).")
        return None

    return None
