"""CLI entrypoint for the local agent runner."""

from __future__ import annotations

import argparse
import logging
import os
import sys


def _env_or_default(env_var: str, default: str) -> str:
    return os.getenv(env_var, default)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python3 -m agents.local_agent",
        description="DaemonCraft Local Agent Runner — drives canonical flow #4 (chat → LLM → embodied_plan → Gemma-Andy → bot).",
    )
    parser.add_argument(
        "--bot-url",
        default=_env_or_default("BOT_API_URL", "http://localhost:3001"),
        help="Mineflayer bot HTTP/WS base URL (env: BOT_API_URL)",
    )
    parser.add_argument(
        "--embodied-url",
        default=_env_or_default("EMBODIED_SERVICE_URL", "http://localhost:7790"),
        help="Embodied service URL (env: EMBODIED_SERVICE_URL)",
    )
    parser.add_argument(
        "--ollama-url",
        default=_env_or_default("OLLAMA_URL", "http://10.10.20.1:11434"),
        help="Ollama API URL for health checks (env: OLLAMA_URL)",
    )
    parser.add_argument(
        "--kimi-key",
        default=os.getenv("KIMI_API_KEY", ""),
        help="Kimi API key (env: KIMI_API_KEY)",
    )
    parser.add_argument(
        "--model",
        default=_env_or_default("KIMI_MODEL", "kimi-k2.6"),
        help="Kimi model name (env: KIMI_MODEL)",
    )
    parser.add_argument(
        "--character",
        default=None,
        help="Path to optional character markdown file",
    )
    parser.add_argument(
        "--cast-soul",
        default=None,
        help="Path to optional cast SOUL markdown file",
    )
    parser.add_argument(
        "--policy-mode",
        choices=["auto", "raw", "policy"],
        default=_env_or_default("POLICY_MODE", "auto"),
        help="Policy mode (env: POLICY_MODE)",
    )
    parser.add_argument(
        "--heartbeat",
        type=int,
        default=30,
        help="Heartbeat interval in seconds (0 disables)",
    )
    parser.add_argument(
        "--history-turns",
        type=int,
        default=20,
        help="Max user+assistant exchanges to keep in context",
    )
    parser.add_argument(
        "--max-tool-rounds",
        type=int,
        default=8,
        help="Max tool-call rounds per turn",
    )
    parser.add_argument(
        "--log-level",
        default="INFO",
        choices=["DEBUG", "INFO", "WARNING", "ERROR"],
        help="Logging level",
    )
    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()

    logging.basicConfig(
        level=getattr(logging, args.log_level),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
        stream=sys.stderr,
    )

    # API key is optional if OAuth credentials exist
    if not args.kimi_key and not os.getenv("KIMI_API_KEY", "").strip():
        from .kimi_oauth import KIMI_CREDENTIALS_PATH

        if not KIMI_CREDENTIALS_PATH.exists():
            print(
                "\nERROR: No Kimi authentication found.\n"
                "Options:\n"
                "  1. Set KIMI_API_KEY env var or pass --kimi-key\n"
                "  2. Run 'kimi login' to create OAuth credentials\n"
                "See https://api.kimi.com for credentials.\n",
                file=sys.stderr,
            )
            raise SystemExit(1)

    # Set POLICY_MODE env so embodied.py sees it
    os.environ["POLICY_MODE"] = args.policy_mode

    import asyncio
    from .runner import run

    try:
        asyncio.run(run(args))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
