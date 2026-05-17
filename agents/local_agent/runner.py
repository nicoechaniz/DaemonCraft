"""Main async orchestrator for the local agent runner."""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import signal
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx

from .bot_io import BotIO, ChatMsg
from .embodied import EMBODIED_PLAN_SCHEMA, handle_call
from .kimi import KimiClient
from .soul import compose_soul

logger = logging.getLogger(__name__)


class JsonlHandler(logging.Handler):
    """Logging handler that emits one JSONL line per record."""

    def __init__(self, stream: Any = None) -> None:
        super().__init__()
        self.stream = stream or sys.stdout

    def emit(self, record: logging.LogRecord) -> None:
        try:
            msg = self.format(record)
            self.stream.write(msg + "\n")
            self.stream.flush()
        except Exception:
            self.handleError(record)


def _make_jsonl_log_record(event_type: str, **kwargs: Any) -> dict[str, Any]:
    return {
        "ts": datetime.now(timezone.utc).isoformat(),
        "event": event_type,
        **kwargs,
    }


def _file_log_path(bot_name: str) -> Path:
    base = Path.home() / ".local" / "share" / "daemoncraft" / "local-agent" / bot_name
    try:
        base.mkdir(parents=True, exist_ok=True)
    except Exception:
        pass
    date = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    return base / f"{date}.jsonl"


class AgentRunner:
    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        self.bot_url = args.bot_url or os.getenv("BOT_API_URL", "http://localhost:3001")
        self.embodied_url = args.embodied_url or os.getenv("EMBODIED_SERVICE_URL", "http://localhost:7790")
        self.ollama_url = args.ollama_url or os.getenv("OLLAMA_URL", "http://10.10.20.1:11434")
        self.api_key = args.kimi_key or os.getenv("KIMI_API_KEY", "")
        self.model = args.model or os.getenv("KIMI_MODEL", "kimi-k2.6")
        self.policy_mode = args.policy_mode or os.getenv("POLICY_MODE", "auto")
        self.heartbeat_interval = args.heartbeat
        self.history_turns = args.history_turns
        self.max_tool_rounds = args.max_tool_rounds

        self.bot_io: BotIO | None = None
        self.kimi: KimiClient | None = None
        self.messages: list[dict[str, Any]] = []
        self.heartbeat_note: str | None = None
        self._shutdown_event = asyncio.Event()
        self._in_flight_task: asyncio.Task[Any] | None = None
        self._pending_msgs: asyncio.Queue[ChatMsg] = asyncio.Queue()
        self._bot_username: str = ""

    # ── Boot ─────────────────────────────────────────────────────

    async def boot(self) -> None:
        logger.info("=== DaemonCraft Local Agent Boot ===")

        # Verify embodied-service health
        try:
            async with httpx.AsyncClient(timeout=5.0) as c:
                r = await c.get(f"{self.embodied_url}/health")
                r.raise_for_status()
                logger.info("embodied-service OK at %s", self.embodied_url)
        except Exception as exc:
            logger.error("embodied-service /health failed: %s", exc)
            print(
                f"\nERROR: Cannot reach embodied-service at {self.embodied_url}\n"
                f"Run: cd agents/embodied-service && npm install && node index.js\n",
                file=sys.stderr,
            )
            raise SystemExit(1)

        # Verify bot health + read username
        try:
            async with httpx.AsyncClient(timeout=5.0) as c:
                r = await c.get(f"{self.bot_url}/health")
                r.raise_for_status()
                data = r.json()
                self._bot_username = data.get("username") or data.get("name") or ""
                logger.info("bot OK at %s (username=%s)", self.bot_url, self._bot_username)
        except Exception as exc:
            logger.error("bot /health failed: %s", exc)
            print(
                f"\nERROR: Cannot reach bot at {self.bot_url}\n"
                f"Make sure the Mineflayer bot is running (node server.js).\n",
                file=sys.stderr,
            )
            raise SystemExit(1)

        # Verify Ollama reachability
        try:
            async with httpx.AsyncClient(timeout=5.0) as c:
                r = await c.get(f"{self.ollama_url}/api/tags")
                r.raise_for_status()
                logger.info("Ollama OK at %s", self.ollama_url)
        except Exception as exc:
            logger.warning("Ollama unreachable (%s) — continuing anyway", exc)

        # Build known bots set
        known_bots_env = os.getenv("MC_KNOWN_BOTS", self._bot_username)
        known_bots = {b.strip().lower() for b in known_bots_env.split(",") if b.strip()}

        self.bot_io = BotIO(
            base_url=self.bot_url,
            my_username=self._bot_username,
            known_bots=known_bots,
        )

        # Compose SOUL
        soul = compose_soul(
            canonical="agents/embodied-service/profile-templates/daemoncraft-base.SOUL.md",
            character=self.args.character,
        )
        if not soul.strip():
            logger.warning("SOUL is empty — proceeding with minimal prompt")
            soul = "You are a Minecraft bot."

        # Init Kimi client
        self.kimi = KimiClient(api_key=self.api_key, model=self.model)

        # Initial messages
        self.messages = [{"role": "system", "content": soul}]
        if self.args.cast_soul:
            cast_path = Path(self.args.cast_soul)
            if cast_path.exists():
                self.messages.append(
                    {"role": "system", "content": cast_path.read_text(encoding="utf-8")}
                )

        logger.info("Boot complete. Listening for chat...")

    # ── Logging helpers ──────────────────────────────────────────

    def _log_stdout(self, event_type: str, **kwargs: Any) -> None:
        line = json.dumps(_make_jsonl_log_record(event_type, **kwargs), ensure_ascii=False)
        print(line)
        sys.stdout.flush()
        self._log_file(event_type, **kwargs)

    def _log_file(self, event_type: str, **kwargs: Any) -> None:
        try:
            path = _file_log_path(self._bot_username or "unknown")
            with path.open("a", encoding="utf-8") as f:
                f.write(
                    json.dumps(
                        _make_jsonl_log_record(event_type, **kwargs),
                        ensure_ascii=False,
                    )
                    + "\n"
                )
        except Exception:
            pass  # best-effort, never fail the run

    # ── LLM turn ─────────────────────────────────────────────────

    async def _llm_turn(self, chat_msg: ChatMsg) -> None:
        """Run one user message through LLM -> tools -> response."""
        user_content = chat_msg.text
        if self.heartbeat_note:
            user_content = f"{user_content}\n\n[{self.heartbeat_note}]"
            self.heartbeat_note = None

        self.messages.append({"role": "user", "content": user_content})
        self._trim_history()

        self._log_stdout(
            "chat_in",
            from_user=chat_msg.from_user,
            text=chat_msg.text,
            urgent=chat_msg.urgent,
        )

        for round_num in range(self.max_tool_rounds):
            try:
                self._log_stdout(
                    "kimi_call",
                    model=self.kimi.model if self.kimi else self.model,
                    round=round_num,
                    message_count=len(self.messages),
                )
                response = await self.kimi.chat(
                    messages=self.messages,
                    tools=[EMBODIED_PLAN_SCHEMA],
                    temperature=0.6,
                )
            except Exception as exc:
                logger.exception("kimi.chat failed")
                self._log_stdout("kimi_error", error=str(exc))
                return

            choice = response.get("choices", [{}])[0]
            msg = choice.get("message", {})
            tool_calls = msg.get("tool_calls", [])

            if tool_calls:
                # Append assistant message with tool_calls
                assistant_msg = {
                    "role": "assistant",
                    "content": msg.get("content", ""),
                    "tool_calls": tool_calls,
                }
                if "reasoning_content" in msg:
                    assistant_msg["reasoning_content"] = msg["reasoning_content"]
                self.messages.append(assistant_msg)

                for tc in tool_calls:
                    fn = tc.get("function", {})
                    name = fn.get("name", "")
                    arguments = fn.get("arguments", "")
                    self._log_stdout("embodied_call", name=name, args=arguments)

                    result_str = await handle_call(name, arguments)
                    self._log_stdout("embodied_result", name=name, result=result_str)

                    self.messages.append({
                        "role": "tool",
                        "tool_call_id": tc.get("id", ""),
                        "name": name,
                        "content": result_str,
                    })

                self._trim_history()
                continue  # next tool round

            # No tool calls — speak if there's content
            content = msg.get("content", "")
            if content:
                await self.bot_io.send_chat(content)
                self._log_stdout("chat_out", text=content)
                self.messages.append({"role": "assistant", "content": content})
                self._trim_history()
            break
        else:
            logger.warning("Max tool rounds (%s) reached", self.max_tool_rounds)
            self._log_stdout("max_tool_rounds_reached", max_rounds=self.max_tool_rounds)

    def _trim_history(self) -> None:
        """Keep last --history-turns user+assistant exchanges (plus system)."""
        system_msgs = [m for m in self.messages if m.get("role") == "system"]
        others = [m for m in self.messages if m.get("role") != "system"]
        # Each "turn" is roughly 2 messages (user + assistant); tool calls add more.
        # Trim others to last N*2 entries as a rough heuristic.
        keep = max(self.history_turns * 2, 4)
        if len(others) > keep:
            others = others[-keep:]
        self.messages = system_msgs + others

    # ── Concurrent tasks ─────────────────────────────────────────

    async def _chat_task(self) -> None:
        """Consume WS frames, classify, queue or interrupt."""
        async for frame in self.bot_io.connect_ws():
            if self._shutdown_event.is_set():
                break
            msgs = self.bot_io.parse_chat_frame(frame)
            for cm in msgs:
                if cm.urgent:
                    # Interrupt in-flight LLM call
                    if self._in_flight_task and not self._in_flight_task.done():
                        self._in_flight_task.cancel()
                        try:
                            await self._in_flight_task
                        except asyncio.CancelledError:
                            pass
                        logger.info("Interrupted in-flight turn for urgent message")
                        self._log_stdout("interrupt", from_user=cm.from_user, text=cm.text)
                    # Clear pending queue to prioritize the urgent message
                    while not self._pending_msgs.empty():
                        try:
                            self._pending_msgs.get_nowait()
                        except asyncio.QueueEmpty:
                            break
                    await self._pending_msgs.put(cm)
                else:
                    await self._pending_msgs.put(cm)

    async def _process_task(self) -> None:
        """Pull from queue and run LLM turns sequentially."""
        while not self._shutdown_event.is_set():
            try:
                cm = await asyncio.wait_for(
                    self._pending_msgs.get(), timeout=1.0
                )
            except asyncio.TimeoutError:
                continue

            self._in_flight_task = asyncio.create_task(self._llm_turn(cm))
            try:
                await self._in_flight_task
            except asyncio.CancelledError:
                logger.info("LLM turn cancelled")
            except Exception:
                logger.exception("LLM turn failed")
            finally:
                self._in_flight_task = None

    async def _heartbeat_task(self) -> None:
        """Periodic heartbeat: fetch status and attach as note."""
        if self.heartbeat_interval <= 0:
            return
        while not self._shutdown_event.is_set():
            try:
                await asyncio.wait_for(
                    self._shutdown_event.wait(), timeout=self.heartbeat_interval
                )
                break
            except asyncio.TimeoutError:
                pass
            try:
                status = await self.bot_io.get_status()
                pos = status.get("position", {})
                health = status.get("health", "?")
                food = status.get("food", "?")
                scene = status.get("scene", {}).get("summary", "")
                note = (
                    f"heartbeat pos=({pos.get('x','?')},{pos.get('y','?')},{pos.get('z','?')}) "
                    f"health={health} food={food} scene={scene}"
                )
                self.heartbeat_note = note
                logger.debug("%s", note)
            except Exception as exc:
                logger.debug("Heartbeat fetch failed: %s", exc)

    # ── Run / Shutdown ───────────────────────────────────────────

    async def run(self) -> None:
        await self.boot()

        # Signal handlers
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            loop.add_signal_handler(sig, self._shutdown_event.set)

        tasks = [
            asyncio.create_task(self._chat_task()),
            asyncio.create_task(self._process_task()),
            asyncio.create_task(self._heartbeat_task()),
        ]

        try:
            await self._shutdown_event.wait()
        finally:
            logger.info("Shutting down...")
            for t in tasks:
                t.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            logger.info("Shutdown complete.")


async def run(args: argparse.Namespace) -> None:
    runner = AgentRunner(args)
    await runner.run()
