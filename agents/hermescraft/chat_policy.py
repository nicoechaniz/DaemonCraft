#!/usr/bin/env python3
"""
Chat Policy — Single source of truth for agent chat behavior.

This module contains pure functions that define how the agent formats,
filters, and delivers chat messages. It is the ONLY place where these
decisions are made. The bot server (server.js) trusts the agent and does
NOT re-apply these rules.

Design principles:
  - Pure functions: no side effects, no server dependencies
  - Testable offline: run `python chat_policy.py` for inline tests
  - Advisory, not restrictive: hints guide the model, never block creativity
  - Single source of truth: changing chat behavior requires editing only this file

Functions:
  filter_noise(text) -> str | None
      Drop meaningless minimal responses ("." , "ok", "hm", short digits).
      Returns None for silence, the cleaned text otherwise.

  enforce_say_format(text) -> (chat_text: str, warnings: list[str])
      Parse agent response into chat-ready text and system hints.
      - Extracts lines starting with "SAY:" (prefix stripped)
      - Truncates lines exceeding 180 characters
      - Gently auto-prefixes short lines missing "SAY:"
      - Separates commands (lines starting with "/")
      Returns the chat text and any warnings to inject next turn.

  detect_language(messages: list[dict]) -> "es" | None
      Detect if player messages are in Spanish.
      Conservative: only flags on strong indicators (¿, ¡, actual Spanish words).
      Never flags English as Spanish (no single-letter markers).
      Returns "es" or None (no hint injected for ambiguous/English text).

Usage in agent_loop.py:
    from hermescraft.chat_policy import filter_noise, enforce_say_format, detect_language

    text = filter_noise(response)
    if text is None:
        return  # silence
    chat_text, warnings = enforce_say_format(text)
    for w in warnings:
        conversation_history.append({"role": "system", "content": w})
    if chat_text:
        post_to_minecraft(chat_text)
"""

from typing import List, Tuple, Optional

# ═══════════════════════════════════════════════════════════════════════════════
# Noise filter
# ═══════════════════════════════════════════════════════════════════════════════

_NOISE_EXACT = frozenset({".", "..", "...", "-", "--", "ok", "okay", "hm", "hmm", "!"})


def filter_noise(text: str) -> Optional[str]:
    """Drop meaningless minimal responses. Return None for silence."""
    if not text:
        return None
    text = text.strip()
    if text in _NOISE_EXACT:
        return None
    if len(text) <= 2 and text.isdigit():
        return None
    return text


# ═══════════════════════════════════════════════════════════════════════════════
# SAY: format enforcement
# ═══════════════════════════════════════════════════════════════════════════════

_MAX_SAY_CHARS = 180


def enforce_say_format(text: str) -> Tuple[str, List[str]]:
    """
    Parse agent response into (chat_text, warnings).

    Returns:
        chat_text: lines ready for the server (SAY: prefix already stripped)
        warnings: list of system hints to inject next turn (empty if ok)

    Behavior:
      - Lines starting with "SAY:" are extracted and the prefix stripped.
      - Lines starting with "/" are treated as commands, not chat.
      - If no SAY: lines exist but short chat-like lines do, they are gently
        auto-prefixed and a hint is generated for the next turn.
      - Long non-SAY lines (>180) are truncated and a hint is generated.
    """
    if not text:
        return "", []

    lines = text.split("\n")
    say_lines: List[str] = []
    cmd_lines: List[str] = []
    other_lines: List[str] = []
    warnings: List[str] = []

    for raw in lines:
        line = raw.strip()
        if not line:
            continue
        if line.startswith("SAY:"):
            content = line[4:].strip()
            if len(content) > _MAX_SAY_CHARS:
                warnings.append(
                    f"[SYSTEM HINT] Your SAY: line was {len(content)} chars. "
                    f"Minecraft rejects anything over {_MAX_SAY_CHARS}. "
                    f"The line was truncated. Split long thoughts into multiple short SAY lines."
                )
                content = content[:_MAX_SAY_CHARS]
            say_lines.append(content)
        elif line.startswith("/"):
            cmd_lines.append(line)
        else:
            other_lines.append(line)

    # If the model already used SAY:, trust it (even if there are also commands)
    if say_lines:
        return "\n".join(say_lines), warnings

    # If there are only commands, no chat output
    if cmd_lines and not other_lines:
        return "", warnings

    # Fallback: short chat-like lines without SAY: get auto-prefixed gently
    if other_lines:
        warnings.append(
            "[SYSTEM HINT] You spoke to the player without using SAY:. "
            "ALL player-facing text MUST start with 'SAY: '. "
            "Example: 'SAY: Hello friend.'"
        )
        for line in other_lines:
            if len(line) <= _MAX_SAY_CHARS:
                say_lines.append(line)
            else:
                say_lines.append(line[:_MAX_SAY_CHARS])
                warnings.append(
                    "[SYSTEM HINT] A line was truncated to 180 chars. Use multiple SAY: lines."
                )
        return "\n".join(say_lines), warnings

    return "", warnings


# ═══════════════════════════════════════════════════════════════════════════════
# Language detection (conservative)
# ═══════════════════════════════════════════════════════════════════════════════

_SPANISH_MARKERS = frozenset({
    "está", "estás", "estan", "están", "estamos",
    "cómo", "como", "dónde", "donde", "cuándo", "cuando",
    "quién", "quien", "qué", "que", "porque", "porqué",
    "vamos", "vamo", "hola", "buenas", "adiós", "chau",
    "bien", "muy", "mucho", "mucha", "muchas", "muchos",
    "también", "tambien", "esta", "este", "esto", "estos", "estas",
    "aquí", "ahi", "ahí", "allá", "ahora", "siempre", "nunca",
    "quizás", "talvez", "verdad", "cierto", "claro",
    "amigo", "amiga", "amigos", "hermano", "hermana",
    "gracias", "por favor", "perdón", "perdon", "lo siento",
    "bueno", "buena", "mal", "mala",
    "voy", "vas", "va", "vamos", "van",
    "soy", "eres", "es", "somos", "son",
    "tengo", "tienes", "tiene", "tenemos", "tienen",
    "hago", "haces", "hace", "hacemos", "hacen",
    "puedo", "puedes", "puede", "podemos", "pueden",
    "quiero", "quieres", "quiere", "queremos", "quieren",
    "sé", "sabes", "sabe", "sabemos", "saben",
    "veo", "ves", "ve", "vemos", "ven",
    "digo", "dices", "dice", "decimos", "dicen",
    "necesito", "necesitas", "necesita", "necesitamos", "necesitan",
})


def detect_language(messages: List[dict]) -> Optional[str]:
    """
    Detect if player messages are in Spanish.
    Returns "es" if confident, None otherwise (no hint injected).

    Conservative: only flags Spanish if there are strong indicators.
    Never flags English as Spanish (no single-letter markers like "a" or "y").
    """
    if not messages:
        return None

    has_spanish = False
    for m in messages:
        txt = m.get("message", "")
        lowered = txt.lower()

        # Strong signal: inverted punctuation (extremely rare in English)
        if "¿" in txt or "¡" in txt:
            has_spanish = True
            continue

        # Word-based detection: require at least one 3+ letter Spanish word
        words = set(w.strip(".,!?;:") for w in lowered.split())
        if words & _SPANISH_MARKERS:
            has_spanish = True
            continue

    if has_spanish:
        return "es"
    return None


# ═══════════════════════════════════════════════════════════════════════════════
# Tests (self-contained, no pytest needed)
# ═══════════════════════════════════════════════════════════════════════════════

def _run_tests():
    """Run inline assertions. Called when module is executed directly."""

    # --- filter_noise ---
    assert filter_noise(".") is None
    assert filter_noise("..") is None
    assert filter_noise("ok") is None
    assert filter_noise("hm") is None
    assert filter_noise("5") is None
    assert filter_noise("42") is None
    assert filter_noise("hello") == "hello"
    assert filter_noise("  hello  ") == "hello"

    # --- enforce_say_format ---
    chat, warns = enforce_say_format("SAY: Hola\nSAY: Adiós")
    assert chat == "Hola\nAdiós"
    assert warns == []

    chat, warns = enforce_say_format("Hola sin prefix")
    assert chat == "Hola sin prefix"
    assert any("SAY:" in w for w in warns)

    chat, warns = enforce_say_format("/tp Siqui 0 0 0")
    assert chat == ""
    assert warns == []

    chat, warns = enforce_say_format("SAY: " + "x" * 200)
    assert chat == "x" * 180
    assert any("180" in w for w in warns)

    chat, warns = enforce_say_format("SAY: Hello\n/tp Siqui 0 0 0")
    assert chat == "Hello"
    assert warns == []

    # --- detect_language ---
    assert detect_language([{"message": "how are you"}]) is None
    assert detect_language([{"message": "a b c d e"}]) is None
    assert detect_language([{"message": "¿cómo estás?"}]) == "es"
    assert detect_language([{"message": "hola amigo"}]) == "es"
    assert detect_language([{"message": "vamos al end"}]) == "es"
    # Mixed: Spanish + English — still flags Spanish (hint is advisory)
    assert detect_language([{"message": "hola"}, {"message": "hello"}]) == "es"

    print("[chat_policy] All tests passed.")


if __name__ == "__main__":
    _run_tests()
