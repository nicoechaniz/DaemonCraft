"""Port of tools/embodied_plan_tool.py — raw + policy + Tier 2a spatial recovery.

Imports agents.gemma_policy (graceful degradation if missing).
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any

import httpx

logger = logging.getLogger(__name__)

EMBODIED_SERVICE_URL = os.getenv("EMBODIED_SERVICE_URL", "http://localhost:7790")
EMBODIED_PLAN_TIMEOUT = float(os.getenv("EMBODIED_PLAN_TIMEOUT", "60"))
BOT_API_URL = os.getenv("BOT_API_URL", "http://localhost:3001")

# ── GemmaPolicy import (graceful) ──────────────────────────────
try:
    from agents.gemma_policy import GemmaPolicy  # type: ignore[import-not-found]
except Exception as exc:
    logger.warning("GemmaPolicy import failed (%s); policy mode will fall back to raw.", exc)
    GemmaPolicy = None  # type: ignore[misc,assignment]

# ── OpenAI-compatible tool schema ──────────────────────────────
EMBODIED_PLAN_SCHEMA: dict[str, Any] = {
    "type": "function",
    "function": {
        "name": "embodied_plan",
        "description": (
            "Send a physical-world intent to the embodied service (Gemma-Andy). "
            "The service composes a tool-call plan, executes it against the Mineflayer bot, "
            "and returns structured results. Use this for ALL movement, mining, building, "
            "crafting, combat, inventory, and farming actions."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "intent": {
                    "type": "string",
                    "description": (
                        "Natural-language description of what the bot should do. "
                        "Be specific about WHAT, WHERE, and WHY. Include constraints and fallbacks."
                    ),
                },
                "autonomy_level": {
                    "type": "integer",
                    "default": 2,
                    "description": "0=observer, 1=assistant, 2=supervised, 3=autonomous, 4=advanced",
                },
                "deadline_seconds": {
                    "type": "integer",
                    "default": 30,
                    "description": "Max seconds for the entire plan execution.",
                },
                "previous_error": {
                    "type": "object",
                    "description": (
                        "When retrying after a failure, pass the last execution_result "
                        "here: {tool, error_type, details}. Gemma-Andy will compose a recovery plan."
                    ),
                },
                "allowed_tools": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Optional whitelist of tool names to restrict the plan.",
                },
                "guardian_constraints": {
                    "type": "object",
                    "description": "Optional override of safety rules.",
                },
            },
            "required": ["intent"],
        },
    },
}

# ── Tier 2a spatial-failure errors ─────────────────────────────
SPATIAL_ERRORS = {"target_occupied", "bot_in_target", "no_solid_neighbor"}


def _policy_mode_default() -> str:
    return "auto" if BOT_API_URL else "raw"


async def _post_intent(body: dict[str, Any]) -> dict[str, Any]:
    """POST /intent to the embodied service with three error wrappers."""
    url = f"{EMBODIED_SERVICE_URL}/intent"
    try:
        async with httpx.AsyncClient(timeout=EMBODIED_PLAN_TIMEOUT) as client:
            resp = await client.post(url, json=body)
    except httpx.TimeoutException:
        logger.warning("embodied_service timeout after %.0fs", EMBODIED_PLAN_TIMEOUT)
        return {
            "ok": False,
            "error": "timeout",
            "details": f"Embodied service did not respond within {EMBODIED_PLAN_TIMEOUT}s",
            "execution_results": [],
        }
    except httpx.NetworkError as exc:
        logger.warning("embodied_service unreachable: %s", exc)
        return {
            "ok": False,
            "error": "unreachable",
            "details": str(exc),
            "execution_results": [],
        }

    try:
        data = resp.json()
    except Exception as exc:
        logger.warning("embodied_service bad JSON (%s): %s", exc, resp.text[:400])
        return {
            "ok": False,
            "error": "bad_response",
            "details": f"Status {resp.status_code}, invalid JSON: {exc}",
            "raw": resp.text[:800],
            "execution_results": [],
        }

    if resp.status_code >= 400:
        logger.warning("embodied_service HTTP %s: %s", resp.status_code, data)
        return {
            "ok": False,
            "error": "http_error",
            "details": f"HTTP {resp.status_code}",
            "raw": data,
            "execution_results": [],
        }

    return data


def _last_error_type(result: dict[str, Any]) -> str | None:
    """Extract the last failed error_type from execution_results."""
    exec_results = result.get("execution_results", [])
    for entry in reversed(exec_results):
        if isinstance(entry, dict) and not entry.get("ok", True):
            return entry.get("error_type")
    return None


def _build_previous_error(result: dict[str, Any]) -> dict[str, Any] | None:
    """Build a previous_error object from the last failed execution_result."""
    exec_results = result.get("execution_results", [])
    for entry in reversed(exec_results):
        if isinstance(entry, dict) and not entry.get("ok", True):
            return {
                "tool": entry.get("tool", "unknown"),
                "error_type": entry.get("error_type", "unknown"),
                "details": entry.get("details", ""),
            }
    return None


async def _raw_handler(args: dict[str, Any]) -> dict[str, Any]:
    """Pass intent directly to embodied-service.

    Tier 2a: if spatial failure, retry once with previous_error.
    """
    body = {
        "intent": args["intent"],
        "autonomy_level": args.get("autonomy_level", 2),
        "deadline_seconds": args.get("deadline_seconds", 30),
    }
    if "allowed_tools" in args:
        body["allowed_tools"] = args["allowed_tools"]
    if "guardian_constraints" in args:
        body["guardian_constraints"] = args["guardian_constraints"]

    result = await _post_intent(body)

    # Tier 2a spatial recovery
    err = _last_error_type(result)
    if err in SPATIAL_ERRORS:
        prev = _build_previous_error(result)
        logger.info("Tier 2a retry for spatial error: %s", err)
        body["previous_error"] = prev
        body["intent"] = f"{args['intent']} (retry: adjust target because {err})"
        result = await _post_intent(body)

    return result


async def _policy_handler(args: dict[str, Any]) -> dict[str, Any]:
    """Run GemmaPolicy, then execute each sub-intent sequentially.

    Threads previous_error from one failure into the next sub-intent.
    """
    if GemmaPolicy is None:
        logger.warning("GemmaPolicy unavailable; falling back to raw handler.")
        return await _raw_handler(args)

    policy = GemmaPolicy()
    policy_result = policy.execute(args["intent"])

    if policy_result.get("policy_handled"):
        # L2 scope cut or L3 ambiguity cut — return upstream-handled result
        return {
            "ok": True,
            "policy_handled": True,
            "policy_layer": policy_result.get("policy_layer"),
            "policy_reason": policy_result.get("policy_reason"),
            "execution_results": [],
        }

    sub_intents = policy_result.get("sub_intents", [])
    categories = policy_result.get("categories", [])
    allowed_tools_chain = policy_result.get("allowed_tools", [])

    if not sub_intents:
        # No decomposition — fall through to raw
        return await _raw_handler(args)

    all_results: list[dict[str, Any]] = []
    previous_error: dict[str, Any] | None = None

    for idx, sub in enumerate(sub_intents):
        category = categories[idx] if idx < len(categories) else "default"
        allowed = allowed_tools_chain[idx] if idx < len(allowed_tools_chain) else None

        body = {
            "intent": sub,
            "autonomy_level": args.get("autonomy_level", 2),
            "deadline_seconds": args.get("deadline_seconds", 30),
            "category": category,
        }
        if allowed:
            body["allowed_tools"] = allowed
        if previous_error:
            body["previous_error"] = previous_error
        if "guardian_constraints" in args:
            body["guardian_constraints"] = args["guardian_constraints"]

        result = await _post_intent(body)
        all_results.append(result)

        # Thread previous_error forward if this sub-intent failed
        if not result.get("ok", True):
            prev = _build_previous_error(result)
            if prev:
                previous_error = prev
            # If spatial error, also do Tier 2a retry for this sub-intent
            err = _last_error_type(result)
            if err in SPATIAL_ERRORS:
                logger.info("Tier 2a retry in policy sub-intent for: %s", err)
                body["previous_error"] = prev
                body["intent"] = f"{sub} (retry: adjust target because {err})"
                result = await _post_intent(body)
                all_results[-1] = result  # replace with retry result
                if not result.get("ok", True):
                    prev2 = _build_previous_error(result)
                    if prev2:
                        previous_error = prev2

    # Aggregate
    ok_all = all(r.get("ok", True) for r in all_results)
    return {
        "ok": ok_all,
        "policy_handled": False,
        "sub_intents": sub_intents,
        "categories": categories,
        "execution_results": [
            r.get("execution_results", []) for r in all_results
        ],
        "raw_results": all_results,
    }


async def handle_call(name: str, raw_args: str) -> str:
    """Dispatcher for tool calls from the LLM.

    Args:
        name: tool name (expected "embodied_plan")
        raw_args: JSON string of arguments

    Returns:
        JSON string for the chat tool round-trip.
    """
    if name != "embodied_plan":
        return json.dumps({"ok": False, "error": f"Unknown tool: {name}"})

    try:
        args = json.loads(raw_args) if isinstance(raw_args, str) else raw_args
    except json.JSONDecodeError as exc:
        return json.dumps({"ok": False, "error": f"Invalid JSON args: {exc}"})

    if not isinstance(args, dict):
        return json.dumps({"ok": False, "error": "Args must be an object"})

    intent = args.get("intent", "")
    if not intent:
        return json.dumps({"ok": False, "error": "Missing required parameter: intent"})

    mode = os.getenv("POLICY_MODE", _policy_mode_default())
    if mode == "auto":
        mode = "policy" if GemmaPolicy is not None else "raw"

    logger.info("embodied_call mode=%s intent=%r", mode, intent)

    if mode == "policy":
        result = await _policy_handler(args)
    else:
        result = await _raw_handler(args)

    return json.dumps(result, ensure_ascii=False, default=str)
