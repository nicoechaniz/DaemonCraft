"""SOUL composer — layers canonical + optional character SOULs."""

from pathlib import Path


def compose_soul(
    *,
    base: str = "agents/SOUL-base.md",
    canonical: str = "agents/embodied-service/profile-templates/daemoncraft-base.SOUL.md",
    character: str | None = None,
) -> str:
    """Compose the system prompt from canonical SOUL + optional character.

    The canonical SOUL (daemoncraft-base.SOUL.md) already references
    SOUL-base.md by convention — we layer the character on top.
    """
    parts: list[str] = []

    canonical_path = Path(canonical)
    if canonical_path.exists():
        parts.append(canonical_path.read_text(encoding="utf-8"))
    else:
        # graceful fallback
        base_path = Path(base)
        if base_path.exists():
            parts.append(base_path.read_text(encoding="utf-8"))

    if character:
        char_path = Path(character)
        if char_path.exists():
            parts.append(char_path.read_text(encoding="utf-8"))

    return "\n\n".join(parts)
