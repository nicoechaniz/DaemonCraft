"""Unit tests for kimi_oauth.py — no real network or credential file changes."""

import json
import time
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from . import kimi_oauth as oauth


def _make_creds(expires_at: float | None = None) -> dict:
    return {
        "access_token": "acc-test",
        "refresh_token": "ref-test",
        "expires_at": expires_at or (time.time() + 3600),
        "expires_in": 3600.0,
        "token_type": "Bearer",
        "scope": "kimi-code",
    }


def test_token_is_expired():
    assert oauth._token_is_expired(time.time() - 1) is True
    assert oauth._token_is_expired(time.time() + 600) is False
    assert oauth._token_is_expired(None) is True
    assert oauth._token_is_expired("bad") is True


def test_read_kimi_credentials_missing():
    with patch.object(oauth, "KIMI_CREDENTIALS_PATH", Path("/nonexistent/kimi-code.json")):
        with pytest.raises(FileNotFoundError):
            oauth.read_kimi_credentials()


def test_read_kimi_credentials_ok(tmp_path: Path):
    creds = _make_creds()
    fake_path = tmp_path / "kimi-code.json"
    fake_path.write_text(json.dumps(creds))
    with patch.object(oauth, "KIMI_CREDENTIALS_PATH", fake_path):
        data = oauth.read_kimi_credentials()
    assert data["access_token"] == "acc-test"


@pytest.mark.asyncio
async def test_refresh_kimi_token():
    with patch("httpx.AsyncClient.post", new_callable=AsyncMock) as mock_post:
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {
            "access_token": "new-acc",
            "refresh_token": "new-ref",
            "expires_in": 900,
            "token_type": "Bearer",
            "scope": "kimi-code",
        }
        mock_resp.raise_for_status = MagicMock()
        mock_post.return_value = mock_resp

        tmp_path = Path("/tmp/test_kimi_oauth_creds.json")
        expired_creds = _make_creds(time.time() - 10)  # force refresh
        with patch.object(oauth, "KIMI_CREDENTIALS_PATH", tmp_path):
            updated = await oauth.refresh_kimi_token(expired_creds)

    assert updated["access_token"] == "new-acc"
    assert updated["refresh_token"] == "new-ref"
    assert "expires_at" in updated


@pytest.mark.asyncio
async def test_refresh_kimi_token_rejected():
    with patch("httpx.AsyncClient.post", new_callable=AsyncMock) as mock_post:
        mock_resp = MagicMock()
        mock_resp.status_code = 401
        mock_resp.text = "invalid_grant"
        mock_post.return_value = mock_resp

        expired_creds = _make_creds(time.time() - 10)  # force refresh
        with pytest.raises(RuntimeError, match="kimi login"):
            await oauth.refresh_kimi_token(expired_creds)


@pytest.mark.asyncio
async def test_resolve_kimi_access_token_env_key():
    """KIMI_API_KEY env var bypasses OAuth."""
    with patch.dict("os.environ", {"KIMI_API_KEY": "sk-from-env"}):
        token = await oauth.resolve_kimi_access_token()
    assert token == "sk-from-env"


@pytest.mark.asyncio
async def test_resolve_kimi_access_token_oauth_fresh():
    """Non-expired credential file returns access_token directly."""
    creds = _make_creds(time.time() + 3600)
    with patch.dict("os.environ", {"KIMI_API_KEY": ""}, clear=True):
        with patch.object(oauth, "read_kimi_credentials", return_value=creds):
            token = await oauth.resolve_kimi_access_token()
    assert token == "acc-test"


@pytest.mark.asyncio
async def test_resolve_kimi_access_token_oauth_refresh():
    """Expired credential triggers refresh."""
    creds = _make_creds(time.time() - 10)
    refreshed = _make_creds(time.time() + 3600)
    refreshed["access_token"] = "refreshed-acc"

    with patch.dict("os.environ", {"KIMI_API_KEY": ""}, clear=True):
        with patch.object(oauth, "read_kimi_credentials", return_value=creds):
            with patch.object(
                oauth, "refresh_kimi_token", new_callable=AsyncMock
            ) as mock_refresh:
                mock_refresh.return_value = refreshed
                token = await oauth.resolve_kimi_access_token()

    assert token == "refreshed-acc"
    mock_refresh.assert_awaited_once()
