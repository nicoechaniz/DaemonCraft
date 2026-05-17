"""Kimi CLI OAuth support — read credentials, auto-refresh, resolve token.

Consumes tokens created by the official `kimi login` CLI.
Does NOT perform the initial OAuth login (device flow) — that still requires
running `kimi login` or the official browser flow.

Credential paths (from upstream kimi-cli):
  - ~/.kimi/credentials/kimi-code.json
  - ~/.kimi/device_id

Ported from hermes_cli/auth.py (commit 52c2bb7b5 and descendants).
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import stat
import subprocess
import time
from pathlib import Path
from typing import Any

import httpx

logger = logging.getLogger(__name__)

KIMI_CODE_CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098"
KIMI_CODE_OAUTH_HOST = os.getenv("KIMI_CODE_OAUTH_HOST", "https://auth.kimi.com")
KIMI_CREDENTIALS_PATH = Path.home() / ".kimi" / "credentials" / "kimi-code.json"
KIMI_DEVICE_ID_PATH = Path.home() / ".kimi" / "device_id"


def _kimi_cli_version() -> str:
    """Return installed kimi-cli version, or a sensible default."""
    try:
        kimi_bin = shutil.which("kimi")
        if kimi_bin:
            result = subprocess.run(
                [kimi_bin, "--version"],
                capture_output=True, text=True, timeout=5,
            )
            for part in result.stdout.strip().split():
                part = part.strip().rstrip(",")
                if part and part[0].isdigit():
                    return part
    except Exception:
        pass
    return "1.37.0"


def _token_is_expired(expires_at: Any, skew_seconds: float = 300) -> bool:
    try:
        exp = float(expires_at)
    except Exception:
        return True
    return exp <= (time.time() + max(0, skew_seconds))


def read_kimi_credentials() -> dict[str, Any]:
    """Read the OAuth credential file written by `kimi login`."""
    if not KIMI_CREDENTIALS_PATH.exists():
        raise FileNotFoundError(
            f"No Kimi OAuth credentials found at {KIMI_CREDENTIALS_PATH}.\n"
            "Run 'kimi login' first to authenticate."
        )
    try:
        raw = KIMI_CREDENTIALS_PATH.read_text(encoding="utf-8")
        data = json.loads(raw)
    except Exception as exc:
        raise ValueError(f"Failed to read Kimi CLI credentials: {exc}") from exc
    if not isinstance(data, dict):
        raise ValueError("Invalid credentials format: expected JSON object")
    return data


def write_kimi_credentials(data: dict[str, Any]) -> Path:
    """Atomically write updated credentials back to disk with restricted perms."""
    KIMI_CREDENTIALS_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = KIMI_CREDENTIALS_PATH.with_suffix(".tmp")
    tmp.write_text(
        json.dumps(data, indent=2, sort_keys=True, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    os.chmod(tmp, stat.S_IRUSR | stat.S_IWUSR)
    tmp.replace(KIMI_CREDENTIALS_PATH)
    return KIMI_CREDENTIALS_PATH


def read_kimi_device_id() -> str:
    """Read the stable device-id used for X-Msh-Device-Id."""
    if KIMI_DEVICE_ID_PATH.exists():
        try:
            return KIMI_DEVICE_ID_PATH.read_text(encoding="utf-8").strip()
        except Exception:
            pass
    return ""


async def refresh_kimi_token(creds: dict[str, Any]) -> dict[str, Any]:
    """Refresh the access token using the refresh_token grant.

    Updates expires_at and persists the new credential blob.
    Parses error payloads for clear relogin guidance.
    """
    refresh_token = str(creds.get("refresh_token", "") or "").strip()
    access_token = str(creds.get("access_token", "") or "").strip()

    if access_token and not _token_is_expired(creds.get("expires_at")):
        # Token still valid — nothing to do
        return creds

    if not refresh_token:
        raise RuntimeError(
            "Kimi CLI OAuth credentials are missing a refresh_token. "
            "Run `kimi login` to re-authenticate."
        )

    url = f"{KIMI_CODE_OAUTH_HOST.rstrip('/')}/api/oauth/token"
    data = {
        "grant_type": "refresh_token",
        "refresh_token": refresh_token,
        "client_id": KIMI_CODE_CLIENT_ID,
    }
    headers = {"Content-Type": "application/x-www-form-urlencoded"}

    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(url, data=data, headers=headers)

    if resp.status_code != 200:
        code = "kimi_oauth_refresh_failed"
        message = f"Kimi token refresh failed with status {resp.status_code}."
        relogin_required = False
        try:
            err = resp.json()
            if isinstance(err, dict):
                err_code = err.get("error")
                if isinstance(err_code, str) and err_code.strip():
                    code = err_code.strip()
                err_desc = err.get("error_description") or err.get("message")
                if isinstance(err_desc, str) and err_desc.strip():
                    message = f"Kimi token refresh failed: {err_desc.strip()}"
        except Exception:
            pass
        if code in {"invalid_grant", "invalid_token", "invalid_request"}:
            relogin_required = True
        if resp.status_code in (401, 403):
            relogin_required = True
        extra = " Run `kimi login` to re-authenticate." if relogin_required else ""
        raise RuntimeError(f"{message}{extra}")

    try:
        payload = resp.json()
    except Exception as exc:
        raise RuntimeError(
            "Kimi token refresh returned invalid JSON. Run `kimi login` to re-authenticate."
        ) from exc

    if not isinstance(payload, dict):
        raise RuntimeError(
            "Kimi token refresh returned an invalid payload. Run `kimi login` to re-authenticate."
        )

    refreshed_access = payload.get("access_token")
    if not isinstance(refreshed_access, str) or not refreshed_access.strip():
        raise RuntimeError(
            "Kimi token refresh response was missing access_token. Run `kimi login` to re-authenticate."
        )

    next_refresh = str(payload.get("refresh_token", refresh_token) or refresh_token).strip()
    expires_in_raw = payload.get("expires_in")
    try:
        expires_in = float(expires_in_raw)
    except Exception:
        expires_in = None

    updated = dict(creds)
    updated["access_token"] = refreshed_access.strip()
    updated["refresh_token"] = next_refresh
    if expires_in is not None and expires_in > 0:
        updated["expires_at"] = time.time() + expires_in
        updated["expires_in"] = expires_in
    else:
        updated["expires_at"] = creds.get("expires_at", time.time() + 3600)
        updated["expires_in"] = creds.get("expires_in", 3600)
    scope = payload.get("scope")
    if isinstance(scope, str) and scope.strip():
        updated["scope"] = scope.strip()
    token_type = payload.get("token_type")
    if isinstance(token_type, str) and token_type.strip():
        updated["token_type"] = token_type.strip()

    write_kimi_credentials(updated)
    logger.info("Kimi OAuth token refreshed successfully")
    return updated


async def resolve_kimi_access_token(
    *,
    force_refresh: bool = False,
) -> str:
    """Return a valid access token, refreshing if necessary.

    Precedence:
      1. KIMI_API_KEY env var (bypass OAuth entirely)
      2. OAuth credentials file (~/.kimi/credentials/kimi-code.json)
         - if expired or force_refresh=True → refresh via auth.kimi.com
      3. Raise with clear instructions
    """
    # 1. Explicit API key takes precedence
    api_key = os.getenv("KIMI_API_KEY", "").strip()
    if api_key:
        return api_key

    # 2. OAuth path
    creds = read_kimi_credentials()
    access_token = str(creds.get("access_token", "") or "").strip()
    refresh_token = str(creds.get("refresh_token", "") or "").strip()
    token_expired = _token_is_expired(creds.get("expires_at"))

    if access_token and not force_refresh and not token_expired:
        return access_token

    if refresh_token:
        creds = await refresh_kimi_token(creds)
        return creds["access_token"]

    if access_token and not force_refresh:
        return access_token

    raise RuntimeError(
        "Kimi CLI OAuth credentials are not usable. Run 'kimi login' to refresh them."
    )
