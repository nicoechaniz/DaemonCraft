"""Bot WebSocket + HTTP helpers.

Ported from gateway/platforms/daemoncraft.py _handle_chat_batch
and bot/server.js HTTP endpoints.
"""

from __future__ import annotations

import asyncio
import json
import logging
import random
import re
from dataclasses import dataclass, field
from typing import AsyncIterator

import httpx
import websockets

logger = logging.getLogger(__name__)


@dataclass
class ChatMsg:
    from_user: str
    text: str
    timestamp: float = 0.0
    urgent: bool = False


class BotIO:
    def __init__(
        self,
        base_url: str = "http://localhost:3001",
        my_username: str | None = None,
        known_bots: set[str] | None = None,
    ):
        self.base_url = base_url.rstrip("/")
        ws_base = self.base_url.replace("http://", "ws://").replace("https://", "wss://")
        self.ws_url = f"{ws_base}/ws"
        self.my_username = (my_username or "").lower()
        self.known_bots = {b.lower() for b in (known_bots or set())}
        self._last_seen_timestamp: float = 0.0
        self._mention_re: re.Pattern[str] | None = None
        if self.my_username:
            self._mention_re = re.compile(
                rf"(?<!\w)@{re.escape(self.my_username)}\b", re.IGNORECASE
            )

    # ── HTTP helpers ─────────────────────────────────────────────

    async def get_username(self) -> str:
        """GET /health -> username."""
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(f"{self.base_url}/health")
            resp.raise_for_status()
            data = resp.json()
            name = data.get("username") or data.get("name") or data.get("botName") or ""
            self.my_username = name.lower()
            if self.my_username:
                self._mention_re = re.compile(
                    rf"(?<!\w)@{re.escape(self.my_username)}\b", re.IGNORECASE
                )
            return name

    async def get_status(self) -> dict:
        """GET /status -> position, health, food, inventory, scene.summary."""
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(f"{self.base_url}/status")
            resp.raise_for_status()
            return resp.json()  # type: ignore[no-any-return]

    async def send_chat(self, message: str, target: str | None = None) -> None:
        """POST /chat/send; optional whisper target."""
        payload: dict = {"message": message}
        if target:
            payload["target"] = target
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(f"{self.base_url}/chat/send", json=payload)
            if resp.status_code >= 400:
                logger.warning("send_chat failed %s: %s", resp.status_code, resp.text)

    # ── WebSocket ────────────────────────────────────────────────

    async def connect_ws(self) -> AsyncIterator[dict]:
        """Yield decoded JSON frames with exponential backoff + jitter."""
        delay = 1.0
        max_delay = 30.0
        while True:
            try:
                logger.info("BotIO WS connecting to %s", self.ws_url)
                async with websockets.connect(self.ws_url) as ws:
                    delay = 1.0  # reset on successful connect
                    async for raw in ws:
                        try:
                            yield json.loads(raw)
                        except json.JSONDecodeError:
                            logger.debug("BotIO WS non-JSON frame: %s", raw[:200])
            except websockets.exceptions.ConnectionClosed as exc:
                logger.warning("BotIO WS closed (%s), reconnect in %.1fs", exc, delay)
            except Exception as exc:
                logger.warning("BotIO WS error (%s), reconnect in %.1fs", exc, delay)
            await asyncio.sleep(delay + random.uniform(0, delay))
            delay = min(delay * 2, max_delay)

    def parse_chat_frame(self, frame: dict) -> list[ChatMsg]:
        """Handle {type:'chat', data:[...]} batches.

        Filters by time > last_seen_timestamp.
        Drops messages from known_bots unless they @mention us.
        Classifies @<me>! as urgent_interrupt.
        """
        msg_type = frame.get("type")
        if msg_type != "chat":
            return []
        entries = frame.get("data", [])
        if not isinstance(entries, list):
            return []

        new_entries = [
            e for e in entries if isinstance(e, dict) and e.get("time", 0) > self._last_seen_timestamp
        ]
        if not new_entries:
            return []

        for e in new_entries:
            self._last_seen_timestamp = max(self._last_seen_timestamp, e.get("time", 0))
        logger.debug("BotIO parsed %d new chat msgs (last_seen=%.0f)", len(new_entries), self._last_seen_timestamp)

        results: list[ChatMsg] = []
        for entry in new_entries:
            from_user = entry.get("from", "")
            text = entry.get("message", "")
            action, stripped = self.is_for_me(text, self.my_username)
            if action == "ignore":
                continue
            is_bot = from_user.lower() in self.known_bots
            mentions_bot = action in ("steer", "interrupt")
            # Drop bot spam unless it @mentions us
            if is_bot and not mentions_bot:
                continue
            results.append(
                ChatMsg(
                    from_user=from_user,
                    text=stripped,
                    timestamp=entry.get("time", 0.0),
                    urgent=(action == "interrupt" and not is_bot),
                )
            )
        return results

    @staticmethod
    def is_for_me(text: str, my_username: str) -> tuple[str, str]:
        """Classify @mention semantics.

        Returns:
            ("ignore" | "steer" | "interrupt", stripped_text)
        """
        if not my_username:
            return "steer", text
        low = text.lower()
        mention_pat = rf"(?<!\w)@{re.escape(my_username.lower())}\b"
        if not re.search(mention_pat, low):
            return "ignore", text

        # Check for urgent interrupt: @name!  (trailing exclamation after mention)
        # Simple heuristic: mention followed by ! within a few chars
        urgent_pat = rf"(?<!\w)@{re.escape(my_username.lower())}\s*!"
        if re.search(urgent_pat, low):
            # strip the @mention and leading/trailing noise
            stripped = re.sub(rf"\b@{re.escape(my_username.lower())}\s*!?\s*", "", text, flags=re.IGNORECASE).strip()
            return "interrupt", stripped

        stripped = re.sub(rf"\b@{re.escape(my_username.lower())}\b\s*", "", text, flags=re.IGNORECASE).strip()
        return "steer", stripped
