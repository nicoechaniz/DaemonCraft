"""Unit tests for embodied.py — mocked _post_intent, no Ollana / no MC."""

from unittest.mock import AsyncMock, patch

import pytest

from . import embodied
from .embodied import SPATIAL_ERRORS, _raw_handler


@pytest.mark.asyncio
async def test_raw_handler_success():
    with patch.object(embodied, "_post_intent", new_callable=AsyncMock) as mock_post:
        mock_post.return_value = {
            "ok": True,
            "execution_results": [{"tool": "goto", "ok": True}],
        }
        result = await _raw_handler({"intent": "go forward"})
    assert result["ok"] is True
    assert mock_post.call_count == 1


@pytest.mark.asyncio
async def test_raw_handler_tier2a_retry():
    """Tier 2a: spatial errors trigger one retry with previous_error."""
    for err in SPATIAL_ERRORS:
        with patch.object(embodied, "_post_intent", new_callable=AsyncMock) as mock_post:
            mock_post.side_effect = [
                {
                    "ok": False,
                    "execution_results": [
                        {"tool": "place_block", "ok": False, "error_type": err, "details": "boom"}
                    ],
                },
                {
                    "ok": True,
                    "execution_results": [
                        {"tool": "place_block", "ok": True}
                    ],
                },
            ]
            result = await _raw_handler({"intent": "place dirt"})

        assert result["ok"] is True, f"Expected success after Tier 2a retry for {err}"
        assert mock_post.call_count == 2, f"Expected 2 calls for {err}"
        second_call_body = mock_post.call_args_list[1].args[0]
        assert "previous_error" in second_call_body
        assert second_call_body["previous_error"]["error_type"] == err


@pytest.mark.asyncio
async def test_raw_handler_tier2a_no_infinite_loop():
    """If retry also fails, do not loop forever."""
    with patch.object(embodied, "_post_intent", new_callable=AsyncMock) as mock_post:
        mock_post.return_value = {
            "ok": False,
            "execution_results": [
                {"tool": "place_block", "ok": False, "error_type": "target_occupied", "details": "still blocked"}
            ],
        }
        result = await _raw_handler({"intent": "place dirt"})

    assert result["ok"] is False
    assert mock_post.call_count == 2  # initial + one retry


@pytest.mark.asyncio
async def test_handle_call_unknown_tool():
    from .embodied import handle_call

    result = await handle_call("unknown_tool", "{}")
    assert "Unknown tool" in result
