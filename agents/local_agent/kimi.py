"""Kimi-K2.6 client — raw httpx, no OpenAI SDK.

Replicates hermes_cli/auth.py:kimi_coding_default_headers and
hermes_cli/_kimi_coding_patches.py model-name preservation.
"""

from __future__ import annotations

import os
import platform
import socket
from pathlib import Path
from typing import Any

import httpx
import logging

logger = logging.getLogger(__name__)

# Replicate _kimi_coding_patches.py — preserve the dot in kimi-k2.6
_KIMI_MODEL_OVERRIDES = {
    "kimi-k2-6": "kimi-k2.6",
}


def _kimi_cli_version() -> str:
    """Best-effort version string; fallback to '1.37.0'."""
    try:
        import shutil
        import subprocess

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


def _kimi_cli_device_id_path() -> Path | None:
    """Return the first existing device-id file (official CLI paths)."""
    candidates = [
        Path.home() / ".kimi" / "device_id",
        Path.home() / ".config" / "kimi-cli" / "device_id",
    ]
    for p in candidates:
        if p.exists():
            return p
    return candidates[0]  # default to official path for write


def kimi_coding_default_headers() -> dict[str, str]:
    """Return the X-Msh-* headers that Kimi's coding API requires."""
    device_id = ""
    device_path = _kimi_cli_device_id_path()
    if device_path and device_path.exists():
        try:
            device_id = device_path.read_text(encoding="utf-8").strip()
        except Exception:
            pass

    version = _kimi_cli_version()

    headers: dict[str, str] = {
        "User-Agent": f"KimiCLI/{version}",
        "X-Msh-Platform": "kimi_cli",
        "X-Msh-Version": version,
        "X-Msh-Device-Name": platform.node() or socket.gethostname(),
        "X-Msh-Device-Model": platform.machine() or "unknown",
        "X-Msh-Os-Version": platform.version() or "unknown",
    }
    if device_id:
        headers["X-Msh-Device-Id"] = device_id
    return headers


def _resolve_model(model: str) -> str:
    """Preserve model name verbatim; only fix known upstream normalizer bugs."""
    return _KIMI_MODEL_OVERRIDES.get(model, model)


class KimiClient:
    def __init__(
        self,
        api_key: str | None = None,
        model: str = "kimi-k2.6",
        base_url: str = "https://api.kimi.com/coding/v1",
        timeout: float = 120.0,
    ):
        self._api_key_arg = api_key
        self._model = model
        self.model = _resolve_model(model)
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self._default_headers = kimi_coding_default_headers()
        self._api_key: str | None = None  # resolved lazily

    async def _resolve_api_key(self) -> str:
        """Return API key: explicit arg → KIMI_API_KEY env → OAuth refresh."""
        if self._api_key is not None:
            return self._api_key

        if self._api_key_arg:
            self._api_key = self._api_key_arg
            return self._api_key

        env_key = os.getenv("KIMI_API_KEY", "").strip()
        if env_key:
            self._api_key = env_key
            return self._api_key

        # OAuth fallback
        from .kimi_oauth import resolve_kimi_access_token

        try:
            self._api_key = await resolve_kimi_access_token()
        except FileNotFoundError as exc:
            raise RuntimeError(
                "No Kimi API key or OAuth credentials found.\n"
                "Options:\n"
                "  1. Set KIMI_API_KEY env var\n"
                "  2. Run 'kimi login' to create OAuth credentials\n"
                "See https://api.kimi.com for credentials."
            ) from exc
        return self._api_key

    async def chat(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
        max_tokens: int | None = None,
        temperature: float = 0.6,
        tool_choice: str | dict[str, Any] = "auto",
    ) -> dict[str, Any]:
        """POST /chat/completions and return the parsed response dict."""
        api_key = await self._resolve_api_key()
        url = f"{self.base_url}/chat/completions"
        headers = {
            **self._default_headers,
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }
        payload: dict[str, Any] = {
            "model": self.model,
            "messages": messages,
            "temperature": temperature,
        }
        if max_tokens is not None:
            payload["max_tokens"] = max_tokens
        if tools:
            payload["tools"] = tools
            payload["tool_choice"] = tool_choice

        async with httpx.AsyncClient(timeout=self.timeout) as client:
            resp = await client.post(url, headers=headers, json=payload)
            if resp.status_code >= 400:
                logger.error("Kimi API error %s: %s", resp.status_code, resp.text[:800])
            resp.raise_for_status()
            return resp.json()  # type: ignore[no-any-return]
