#!/usr/bin/env python3
"""Per-agent workspace bootstrap using Mariano's hermes-memory-kit architecture.

Each agent gets its own HERMES_HOME at ~/agents/<name>/hermes-home/
with its own gateway process (hermes-gateway@<name>.service).
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

AGENTS_ROOT = Path.home() / "agents"
MEMORY_KIT_DIR = Path.home() / "Projects" / "hermes-memory-kit"
HERMES_FORK_DIR = Path.home() / "Projects" / "hermes-agent"
BOOTSTRAP_SCRIPT = MEMORY_KIT_DIR / "scripts" / "bootstrap_agent.py"
SYSTEMD_TEMPLATE = MEMORY_KIT_DIR / "templates" / "systemd" / "hermes-gateway@.service"
SYSTEMD_USER_DIR = Path.home() / ".config" / "systemd" / "user"


def _log(msg: str, cast_name: str | None = None) -> None:
    prefix = f"[{cast_name}] " if cast_name else ""
    print(f"{prefix}{msg}", flush=True)


def bootstrap_agent_workspace(
    agent_name: str,
    port: int,
    model: str,
    provider: str,
    base_url: str,
    extra_toolsets: list[str] | None = None,
    cast_name: str | None = None,
    known_bots: str = "",
) -> Path:
    """Create or update a per-agent workspace with its own gateway.

    Returns the workspace root (e.g. ~/agents/steve).
    """
    safe_name = agent_name.lower().replace(" ", "-")
    workspace = AGENTS_ROOT / safe_name
    hermes_home = workspace / "hermes-home"

    # ── 1. Bootstrap workspace with memory-kit ─────────────────
    if not workspace.exists():
        _log(f"Bootstrapping workspace: {workspace}", cast_name)
        result = subprocess.run(
            [sys.executable, str(BOOTSTRAP_SCRIPT), str(workspace), "--name", safe_name],
            capture_output=True, text=True,
        )
        if result.returncode != 0:
            raise RuntimeError(f"Bootstrap failed: {result.stderr}")
        _log(f"Workspace bootstrapped: {workspace}", cast_name)
    else:
        _log(f"Workspace exists: {workspace}", cast_name)

    # ── 2. Create plan workspace directory (Autonomía Corporal) ──
    plan_dir = workspace / "workspace"
    plan_dir.mkdir(parents=True, exist_ok=True)
    _log(f"Plan workspace ready: {plan_dir}", cast_name)

    # ── 3. Write config.yaml with daemoncraft platform ─────────
    import yaml

    config = {
        "model": {
            "default": model,
            "provider": provider,
        },
        "providers": {
            provider: {
                "provider": provider,
                "base_url": base_url,
                "api_mode": "anthropic_messages",
            },
        },
        "fallback_providers": [],
        "toolsets": ["embodiment", "memory", "vision"],
        "platform_toolsets": {
            "daemoncraft": ["embodiment", "memory", "vision"],
        },
        "agent": {
            "max_turns": 6,
            "turn_timeout_seconds": 45,
        },
        "terminal": {"backend": "local", "cwd": ".", "timeout": 180},
        "compression": {
            "enabled": True,
            "threshold": 0.77,
            "target_ratio": 0.2,
            "protect_first_n": 0,
            "protect_last_n": 20,
        },
        "memory": {
            "memory_enabled": True,
            "user_profile_enabled": True,
            "provider": "hmk-memory",
        },
        "group_sessions_per_user": False,
        "streaming": {"enabled": False},
        "plugins": {
            "enabled": ["dialogue-handoff", "hmk-memory"],
        },
        "platforms": {
            "daemoncraft": {
                "enabled": True,
                "extra": {
                    "bot_api_url": f"http://localhost:{port}",
                    "bot_username": agent_name,
                },
            },
        },
        "tts": {
            "provider": "edge",
            "edge": {
                "voice": "es-MX-JorgeNeural",
            },
        },
    }

    if extra_toolsets:
        for ts in extra_toolsets:
            if ts not in config["toolsets"]:
                config["toolsets"].append(ts)
            if ts not in config["platform_toolsets"]["daemoncraft"]:
                config["platform_toolsets"]["daemoncraft"].append(ts)

    config_path = hermes_home / "config.yaml"
    config_path.write_text(yaml.dump(config, default_flow_style=False, sort_keys=False))
    _log(f"Config written: {config_path}", cast_name)

    # ── 4. Write .env ──────────────────────────────────────────
    env_path = hermes_home / ".env"
    prov_upper = provider.upper().replace("-", "_").replace("_OAUTH", "")

    # Inherit provider API keys from global .env (avoid "Connection error" on update)
    provider_keys = ""
    platform_keys = ""  # NVIDIA, embed provider, etc.
    global_env = Path.home() / ".hermes" / ".env"
    if global_env.exists():
        for line in global_env.read_text().splitlines():
            stripped = line.strip()
            if not stripped or stripped.startswith("#"):
                continue
            if "=" in stripped:
                key_name = stripped.split("=", 1)[0].strip()
                # Match provider-specific keys: MINIMAX_API_KEY, KIMI_API_KEY, etc.
                if key_name.startswith(prov_upper) and key_name.endswith("_API_KEY"):
                    provider_keys += f"{stripped}\n"
                # Also inherit platform-level keys: NVIDIA, embed provider
                elif key_name in ("NVIDIA_API_KEY", "HERMES_EMBED_PROVIDER"):
                    platform_keys += f"{stripped}\n"

    env_content = f"""# {agent_name} — DaemonCraft Minecraft Agent
MC_API_URL=http://localhost:{port}
MC_USERNAME={agent_name}
MC_KNOWN_BOTS={known_bots_csv}
HERMES_PLATFORM=daemoncraft
HERMES_MAX_ITERATIONS=6
HERMES_TURN_TIMEOUT_SECONDS=45
GATEWAY_ALLOW_ALL_USERS=true

# Autonomía Corporal — embodied service (Gemma-Andy)
EMBODIED_SERVICE_URL=http://localhost:7790
PLAN_FILE={workspace}/workspace/plan.json

# Memory Kit
HMK_AGENT_MEMORY_BASE={workspace}/agent-memory
HERMES_HOME={hermes_home}

# Provider
{platform_keys}{provider_keys}{prov_upper}_BASE_URL={base_url}
"""
    env_path.write_text(env_content)
    _log(f".env written: {env_path}", cast_name)

    # ── 5. Link hermes-agent from deploy (shared code) ──────────
    app_dir = workspace / "app"
    deploy = Path.home() / ".hermes" / "hermes-agent"
    if not app_dir.exists():
        app_dir.symlink_to(deploy)
        _log(f"Symlinked app/ → {deploy}", cast_name)

    # ── 6. Create venv ─────────────────────────────────────────
    venv_dir = app_dir / "venv"
    if not venv_dir.exists():
        _log(f"Creating venv: {venv_dir}", cast_name)
        subprocess.run([sys.executable, "-m", "venv", str(venv_dir)], capture_output=True)
        subprocess.run(
            [str(venv_dir / "bin" / "pip"), "install", "-e", str(app_dir)],
            capture_output=True,
        )
    # Symlink at workspace root (systemd expects it there)
    ws_venv_link = workspace / "venv"
    if not ws_venv_link.exists():
        ws_venv_link.symlink_to("app/venv")

    _log(f"Venv ready: {venv_dir}", cast_name)

    # ── 7. Symlink shared skills ────────────────────────────────
    shared_skills = [
        (Path.home() / ".hermes" / "skills" / "mariano-memory-kit", "mariano-memory-kit"),
    ]
    skills_dir = hermes_home / "skills"
    skills_dir.mkdir(parents=True, exist_ok=True)
    for src, name in shared_skills:
        dst = skills_dir / name
        if src.exists() and not dst.exists():
            dst.symlink_to(src)
            _log(f"Symlinked skill: {name}", cast_name)

    # ── 8. Install systemd service ─────────────────────────────
    service_dst = SYSTEMD_USER_DIR / "hermes-gateway@.service"
    if not service_dst.exists():
        shutil.copy2(SYSTEMD_TEMPLATE, service_dst)
        subprocess.run(["systemctl", "--user", "daemon-reload"], capture_output=True)
        _log("Systemd service installed", cast_name)

    # Enable the service for this agent
    subprocess.run(
        ["systemctl", "--user", "enable", f"hermes-gateway@{safe_name}.service"],
        capture_output=True,
    )

    # ── 9. Initialize memory DB ────────────────────────────────
    hmk_script = workspace / "scripts" / "hmk"
    if hmk_script.exists():
        subprocess.run(
            ["bash", str(hmk_script), "memoryctl.py", "init"],
            cwd=str(workspace), capture_output=True,
        )

    return workspace


def start_agent_gateway(agent_name: str, cast_name: str | None = None) -> None:
    """Start (or restart) the systemd gateway service for this agent."""
    safe_name = agent_name.lower().replace(" ", "-")
    service = f"hermes-gateway@{safe_name}.service"
    _log(f"Starting gateway: {service}", cast_name)
    subprocess.run(
        ["systemctl", "--user", "restart", service],
        capture_output=True,
    )


def stop_agent_gateway(agent_name: str, cast_name: str | None = None) -> None:
    """Stop the systemd gateway service for this agent."""
    safe_name = agent_name.lower().replace(" ", "-")
    service = f"hermes-gateway@{safe_name}.service"
    _log(f"Stopping gateway: {service}", cast_name)
    subprocess.run(
        ["systemctl", "--user", "stop", service],
        capture_output=True,
    )


def gateway_is_running(agent_name: str) -> bool:
    """Check if the systemd gateway service is active."""
    safe_name = agent_name.lower().replace(" ", "-")
    result = subprocess.run(
        ["systemctl", "--user", "is-active", f"hermes-gateway@{safe_name}.service"],
        capture_output=True, text=True,
    )
    return result.stdout.strip() == "active"


def get_agent_venv_python(agent_name: str) -> str:
    """Return the path to the agent workspace's venv python."""
    safe_name = agent_name.lower().replace(" ", "-")
    return str(AGENTS_ROOT / safe_name / "venv" / "bin" / "python")
