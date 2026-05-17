"""Unit tests for kimi.py — no network calls."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from .kimi import KimiClient, _resolve_model, kimi_coding_default_headers


def test_resolve_model_preserve_dot():
    assert _resolve_model("kimi-k2.6") == "kimi-k2.6"
    assert _resolve_model("kimi-k2-6") == "kimi-k2.6"
    assert _resolve_model("kimi-k1.5") == "kimi-k1.5"


def test_kimi_coding_headers_shape():
    headers = kimi_coding_default_headers()
    assert headers["X-Msh-Platform"] == "kimi_cli"
    assert "X-Msh-Version" in headers
    assert "X-Msh-Device-Name" in headers
    assert "X-Msh-Device-Model" in headers
    assert "X-Msh-Os-Version" in headers
    assert "User-Agent" in headers


@pytest.mark.asyncio
async def test_chat_posts_correct_payload():
    client = KimiClient(api_key="sk-test", model="kimi-k2.6")

    mock_resp = MagicMock()
    mock_resp.json.return_value = {
        "choices": [{"message": {"content": "hello"}}],
        "usage": {"prompt_tokens": 10, "completion_tokens": 2},
    }
    mock_resp.status_code = 200
    mock_resp.raise_for_status = MagicMock()

    with patch("httpx.AsyncClient.post", new_callable=AsyncMock) as mock_post:
        mock_post.return_value = mock_resp
        result = await client.chat(
            messages=[{"role": "user", "content": "hi"}],
            tools=[{"type": "function", "function": {"name": "test"}}],
        )

    assert result["choices"][0]["message"]["content"] == "hello"
    call_args = mock_post.call_args
    payload = call_args.kwargs["json"]
    headers = call_args.kwargs["headers"]

    assert payload["model"] == "kimi-k2.6"
    assert "X-Msh-Platform" in headers
    assert headers["Authorization"].startswith("Bearer ")
    assert payload["tools"] is not None


@pytest.mark.asyncio
async def test_chat_preserves_custom_model_name():
    client = KimiClient(api_key="sk-test", model="custom-model-v1.2")
    mock_resp = MagicMock()
    mock_resp.status_code = 200
    mock_resp.json.return_value = {"choices": []}
    mock_resp.raise_for_status = MagicMock()

    with patch("httpx.AsyncClient.post", new_callable=AsyncMock) as mock_post:
        mock_post.return_value = mock_resp
        await client.chat(messages=[{"role": "user", "content": "hi"}])

    payload = mock_post.call_args.kwargs["json"]
    assert payload["model"] == "custom-model-v1.2"
