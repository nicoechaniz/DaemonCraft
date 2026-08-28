from pathlib import Path

import pytest

from agents.daemoncraft import resolve_hermes_python


def test_resolve_hermes_python_prefers_explicit_override(monkeypatch, tmp_path):
    runtime = tmp_path / "python"
    runtime.touch()
    monkeypatch.setenv("HERMES_PYTHON", str(runtime))

    assert resolve_hermes_python() == str(runtime)


def test_resolve_hermes_python_rejects_missing_override_and_installations(
    monkeypatch, tmp_path
):
    monkeypatch.setenv("HERMES_PYTHON", str(tmp_path / "missing"))
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: tmp_path))

    with pytest.raises(RuntimeError, match="No Hermes Python runtime found"):
        resolve_hermes_python()
