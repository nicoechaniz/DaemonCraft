"""Tests for recovery_candidates.py — deterministic substitute synthesis.

Each test mocks bot state and asserts that maybe_synthesize_substitute
returns a rewritten intent containing explicit alternative coords/blocks.
Validates Codex's Path D at the autonomous-loop retry layer.
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "agents"))

import pytest

from recovery_candidates import maybe_synthesize_substitute


def _step_with_intent(intent: str):
    """Minimal Step-shaped object for the function under test."""
    class _S:
        pass
    s = _S()
    s.intent = intent
    return s


def test_target_occupied_synthesises_adjacent_air_coord():
    """When place_block fails because target is occupied, the synthesiser
    must return an intent that names a face-adjacent air voxel."""
    step = _step_with_intent("Place 1 oak_planks at coordinates (5, 65, 38).")
    embodied_result = {
        "ok": False,
        "execution_results": [{
            "tool": "place_block",
            "ok": False,
            "error_type": "bot_action_failed",
            "details": "Can't place oak_planks at 5, 65, 38: target space is occupied by leaf_litter.",
        }],
    }
    # Mocked world state: (5, 65, 38) is occupied; (6, 65, 38) is air with neighbor (6, 64, 38)=dirt
    nearby_blocks = [
        {"x": 5, "y": 65, "z": 38, "name": "leaf_litter"},
        {"x": 5, "y": 64, "z": 38, "name": "dirt"},
        {"x": 6, "y": 65, "z": 38, "name": "air"},
        {"x": 6, "y": 64, "z": 38, "name": "dirt"},
    ]
    new_intent = maybe_synthesize_substitute(step, embodied_result,
                                             bot_position=(5, 65, 39), nearby_blocks=nearby_blocks)
    assert new_intent is not None, "must synthesise a substitute when target_occupied"
    # The new intent must name a different coord that's air with a neighbor
    assert "(6, 65, 38)" in new_intent or "(5, 64, 38)" in new_intent, \
        f"expected an adjacent air coord; got: {new_intent}"
    # The new intent must NOT name the failing coord
    assert "(5, 65, 38)" not in new_intent, \
        f"new intent must avoid the failing coord; got: {new_intent}"


def test_no_solid_neighbor_synthesises_support_block_first():
    """When place_block fails because no solid neighbor, synthesiser
    returns a 2-step intent: place support block, then place target."""
    step = _step_with_intent("Place 1 oak_planks at coordinates (10, 70, 10).")
    embodied_result = {
        "ok": False,
        "execution_results": [{
            "tool": "place_block",
            "ok": False,
            "error_type": "bot_action_failed",
            "details": "Can't place oak_planks at 10, 70, 10: no solid adjacent block to place against.",
        }],
    }
    # Solid block exists deeper at (10, 64, 10) — provides a column to build up from
    nearby_blocks = [
        {"x": 10, "y": 64, "z": 10, "name": "dirt"},
    ]
    new_intent = maybe_synthesize_substitute(step, embodied_result,
                                             bot_position=(10, 65, 11), nearby_blocks=nearby_blocks)
    assert new_intent is not None
    # Must reference the 2-step recovery (support first, then target)
    assert "Step 1" in new_intent or "first" in new_intent.lower(), \
        f"expected 2-step plan; got: {new_intent}"


def test_target_is_bot_position_synthesises_horizontal_neighbor():
    """When place_block fails because the target is the bot's own position,
    the synthesiser picks a horizontally adjacent coord."""
    step = _step_with_intent("Place 1 oak_planks at coordinates (4, 65, 38).")
    embodied_result = {
        "ok": False,
        "execution_results": [{
            "tool": "place_block",
            "ok": False,
            "error_type": "bot_action_failed",
            "details": "The bot is currently standing at (4, 65, 38) and cannot place a block in the space it occupies.",
        }],
    }
    nearby_blocks = [
        {"x": 5, "y": 65, "z": 38, "name": "air"},
        {"x": 5, "y": 64, "z": 38, "name": "dirt"},
    ]
    new_intent = maybe_synthesize_substitute(step, embodied_result,
                                             bot_position=(4, 65, 38), nearby_blocks=nearby_blocks)
    assert new_intent is not None
    # Must name a coord different from bot pos
    import re
    coords = re.findall(r"\((\d+),\s*(\d+),\s*(\d+)\)", new_intent)
    assert any(c != ("4", "65", "38") for c in coords), \
        f"new intent must name a coord != bot pos; got: {new_intent}"


def test_missing_inventory_item_synthesises_substitute_block():
    """When place_block fails because the requested block isn't in inventory,
    the synthesiser swaps to an actually-held block of similar role."""
    step = _step_with_intent("Place 1 cobblestone at coordinates (5, 65, 38).")
    embodied_result = {
        "ok": False,
        "execution_results": [{
            "tool": "place_block",
            "ok": False,
            "error_type": "bot_action_failed",
            "details": "Can't place cobblestone at 5, 65, 38: no cobblestone in inventory.",
        }],
    }
    inventory = {"oak_planks": 40, "leaf_litter": 5, "stick": 2}
    new_intent = maybe_synthesize_substitute(step, embodied_result,
                                             bot_position=(4, 65, 38),
                                             nearby_blocks=[{"x": 5, "y": 64, "z": 38, "name": "dirt"}],
                                             inventory=inventory)
    assert new_intent is not None
    # Must name a block we DO have
    assert "oak_planks" in new_intent, \
        f"expected oak_planks substitute (held in inventory); got: {new_intent}"
    # Must NOT mention cobblestone as the active block to place
    assert "Place 1 cobblestone" not in new_intent, \
        f"new intent must not re-emit the missing block; got: {new_intent}"


def test_returns_none_when_details_unparseable():
    """If the failure details don't match any known subtype, the synthesiser
    returns None and the loop falls through to its existing retry path."""
    step = _step_with_intent("Place 1 oak_planks at coordinates (5, 65, 38).")
    embodied_result = {
        "ok": False,
        "execution_results": [{
            "tool": "place_block",
            "ok": False,
            "error_type": "bot_action_failed",
            "details": "Some weird unmodeled failure.",
        }],
    }
    new_intent = maybe_synthesize_substitute(step, embodied_result,
                                             bot_position=(4, 65, 38), nearby_blocks=[])
    assert new_intent is None, \
        "unmodeled failure must return None to preserve fallback behavior"


def test_returns_none_when_no_failure():
    """If the embodied result is OK, no substitute needed."""
    step = _step_with_intent("Place 1 oak_planks at coordinates (5, 65, 38).")
    embodied_result = {"ok": True, "execution_results": [{"tool": "place_block", "ok": True}]}
    assert maybe_synthesize_substitute(step, embodied_result,
                                       bot_position=(4, 65, 38), nearby_blocks=[]) is None
