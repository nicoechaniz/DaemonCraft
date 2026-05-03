#!/usr/bin/env python3
"""
DaemonCraft — Generic Cast Launcher for Minecraft Agent Modes

Launch multi-agent casts from YAML configuration files.
Each cast defines a set of agents, their personalities, and shared world rules.

Usage:
    ./daemoncraft.py start companion         # Launch companion cast
    ./daemoncraft.py start civilization      # Launch civilization cast
    ./daemoncraft.py start landfolk          # Launch landfolk cast
    ./daemoncraft.py status companion        # Check all agents
    ./daemoncraft.py stop companion          # Stop all agents
    ./daemoncraft.py logs companion Steve    # Tail logs for an agent
    ./daemoncraft.py restart companion       # Full restart

Cast configs live in: casts/<name>.yaml
Each agent runs as two processes:
  - Bot server: node server.js (HTTP API for Minecraft control)
  - Hermes agent: hermes -p <profile> chat (LLM reasoning)
"""

import argparse
import json
import os
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path

# ── Paths ────────────────────────────────────────────────────────────────────

SCRIPT_DIR = Path(__file__).parent.resolve()
AGENTS_DIR = SCRIPT_DIR
BOT_DIR = AGENTS_DIR / "bot"
CASTS_DIR = AGENTS_DIR / "casts"
PROMPTS_DIR = AGENTS_DIR / "prompts"
RUN_DIR_BASE = Path.home() / ".local" / "share" / "daemoncraft"

DEFAULT_MC_HOST = "localhost"
DEFAULT_MC_PORT = 25565

# Base profile and SOUL for all DaemonCraft agents
BASE_PROFILE_NAME = "daemoncraft-base"
BASE_SOUL_FILE = AGENTS_DIR / "SOUL-base.md"


def _get_all_known_bots() -> str:
    """Collect all agent names from every cast config for cross-bot awareness."""
    bots = set()
    for cast_file in CASTS_DIR.glob("*.yaml"):
        try:
            import yaml
            cfg = yaml.safe_load(cast_file.read_text()) or {}
            for agent in cfg.get("agents", []):
                name = agent.get("name", "")
                if name:
                    bots.add(name.lower())
        except Exception:
            pass
    # Allow manual override via env var
    override = os.getenv("MC_KNOWN_BOTS", "")
    if override:
        for name in override.split(","):
            bots.add(name.strip().lower())
    return ",".join(sorted(bots))

# ── Logging ──────────────────────────────────────────────────────────────────

def log(msg: str, cast: str = ""):
    prefix = f"[{cast}]" if cast else "[DC]"
    print(f"{prefix} {msg}")


def error(msg: str):
    print(f"[DC ERROR] {msg}", file=sys.stderr)
    sys.exit(1)


# ── YAML Loading ─────────────────────────────────────────────────────────────

def load_cast(name: str) -> dict:
    """Load a cast configuration from YAML."""
    cast_file = CASTS_DIR / f"{name}.yaml"
    if not cast_file.exists():
        error(f"Cast '{name}' not found. Expected: {cast_file}")

    try:
        import yaml
    except ImportError:
        error("PyYAML required: pip install pyyaml")

    config = yaml.safe_load(cast_file.read_text()) or {}
    config["_name"] = name
    return config


# ── Runtime Directories ──────────────────────────────────────────────────────

def get_run_dir(cast_name: str) -> Path:
    d = RUN_DIR_BASE / cast_name
    d.mkdir(parents=True, exist_ok=True)
    return d


def get_pid_dir(cast_name: str) -> Path:
    d = get_run_dir(cast_name) / "pids"
    d.mkdir(parents=True, exist_ok=True)
    return d


def get_log_dir(cast_name: str) -> Path:
    d = get_run_dir(cast_name) / "logs"
    d.mkdir(parents=True, exist_ok=True)
    return d


# ── PID Management ───────────────────────────────────────────────────────────

def pid_file(cast_name: str, agent_name: str, kind: str) -> Path:
    return get_pid_dir(cast_name) / f"{agent_name}_{kind}.pid"


def log_file(cast_name: str, agent_name: str, kind: str) -> Path:
    return get_log_dir(cast_name) / f"{agent_name}_{kind}.log"


def read_pid(cast_name: str, agent_name: str, kind: str) -> int | None:
    pf = pid_file(cast_name, agent_name, kind)
    if pf.exists():
        try:
            return int(pf.read_text().strip())
        except ValueError:
            return None
    return None


def write_pid(cast_name: str, agent_name: str, kind: str, pid: int):
    pid_file(cast_name, agent_name, kind).write_text(str(pid))


def remove_pid(cast_name: str, agent_name: str, kind: str):
    pid_file(cast_name, agent_name, kind).unlink(missing_ok=True)


def is_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except (OSError, ProcessLookupError):
        return False


# ── Profile Setup ──────────────────────────────────────────────────────────────────

def ensure_base_profile() -> Path:
    """Ensure the daemoncraft-base profile exists. Creates it from default if missing."""
    hermes_agent_dir = Path.home() / ".hermes" / "hermes-agent"
    if str(hermes_agent_dir) not in sys.path:
        sys.path.insert(0, str(hermes_agent_dir))
    from hermes_cli.profiles import create_profile, get_profile_dir, profile_exists

    if profile_exists(BASE_PROFILE_NAME):
        return get_profile_dir(BASE_PROFILE_NAME)

    log(f"Creating base profile: {BASE_PROFILE_NAME}")
    profile_dir = create_profile(name=BASE_PROFILE_NAME, clone_from="default", clone_config=True, no_alias=True)

    # Write clean base config — no personalities, right toolsets, compression off
    import yaml
    base_config = {
        "model": {"default": ""},
        "providers": {},
        "fallback_providers": [],
        "credential_pool_strategies": {},
        "toolsets": ["minecraft", "messaging"],
        "platform_toolsets": {"cli": ["minecraft", "clarify", "messaging"]},
        "agent": {
            "max_turns": 100,
            "gateway_timeout": 1800,
            "restart_drain_timeout": 60,
            "api_max_retries": 3,
            "service_tier": "",
            "tool_use_enforcement": "auto",
            "gateway_timeout_warning": 900,
            "gateway_notify_interval": 600,
            "reasoning_effort": "xhigh",
            "verbose": False,
        },
        "compression": {"enabled": False},
    }
    (profile_dir / "config.yaml").write_text(yaml.dump(base_config, default_flow_style=False, sort_keys=False))

    # Write base SOUL
    if BASE_SOUL_FILE.exists():
        (profile_dir / "SOUL.md").write_text(BASE_SOUL_FILE.read_text())
        log(f"Wrote base SOUL to {BASE_PROFILE_NAME}")

    return profile_dir


def setup_agent_profile(
    cast_name: str,
    agent: dict,
    soul_file: Path | None = None,
) -> Path:
    """Create or update a Hermes profile for an agent."""
    name = agent["name"]
    template = agent.get("template", name.lower())
    port = agent["port"]
    model = agent.get("model")
    profile_name = name.lower().replace(" ", "-")

    # Import hermes internals
    hermes_agent_dir = Path.home() / ".hermes" / "hermes-agent"
    if str(hermes_agent_dir) not in sys.path:
        sys.path.insert(0, str(hermes_agent_dir))

    from hermes_cli.profiles import create_profile, get_profile_dir, profile_exists

    # Ensure base profile exists first
    ensure_base_profile()

    # Create profile if needed — clone from daemoncraft-base, not generic default
    if profile_exists(profile_name):
        profile_dir = get_profile_dir(profile_name)
        log(f"Profile '{profile_name}' exists, updating...", cast_name)
    else:
        log(f"Creating profile: {profile_name}", cast_name)
        profile_dir = create_profile(name=profile_name, clone_from=BASE_PROFILE_NAME, clone_config=True)

    # Build composite SOUL: base + cast soul + character prompt
    soul_parts = []

    # 1. Base SOUL — universal DaemonCraft rules
    if BASE_SOUL_FILE.exists():
        soul_parts.append(BASE_SOUL_FILE.read_text())

    # 2. Cast-specific SOUL — mode behavior
    if soul_file and soul_file.exists():
        soul_parts.append(f"\n\n---\n\n{soul_file.read_text()}")

    # 3. Character prompt — individual personality
    prompt_file = PROMPTS_DIR / f"{template}.md"
    if not prompt_file.exists():
        prompt_file = PROMPTS_DIR / template / f"{template}.md"

    if prompt_file.exists():
        char_prompt = prompt_file.read_text()
        soul_parts.append(f"\n\n---\n\n{char_prompt}")
    else:
        log(f"Warning: no prompt found for template '{template}'", cast_name)

    if soul_parts:
        soul_dst = profile_dir / "SOUL.md"
        soul_dst.write_text("\n".join(soul_parts))
        log(f"Wrote composite SOUL for {name}", cast_name)

    # Update config — MERGE with existing, don't overwrite
    import yaml
    config_path = profile_dir / "config.yaml"
    config = yaml.safe_load(config_path.read_text()) or {} if config_path.exists() else {}

    # Set model with provider — infer provider from model name if not specified
    if model:
        provider = agent.get("provider")
        base_url = agent.get("base_url")
        if not provider:
            # Auto-infer provider from model name
            model_lower = model.lower()
            if "minimax" in model_lower:
                provider = "minimax"
                base_url = base_url or "https://api.minimax.io/anthropic"
            elif "kimi" in model_lower:
                provider = "kimi-coding"
            elif "glm" in model_lower:
                provider = "glm"
            elif "claude" in model_lower or "opus" in model_lower:
                provider = "anthropic"
            elif "gpt" in model_lower or "o1" in model_lower or "o3" in model_lower:
                provider = "openai"
            elif "codex" in model_lower:
                provider = "openai"
                base_url = base_url or "https://api.openai.com/v1"

        config["model"] = {"default": model}
        if provider:
            config["model"]["provider"] = provider
        if base_url:
            config["providers"] = config.get("providers", {})
            config["providers"][provider] = {
                "provider": provider,
                "base_url": base_url,
            }

    config_path.write_text(yaml.dump(config, default_flow_style=False, sort_keys=False))

    # Merge extra toolsets from cast config
    extra_toolsets = agent.get("extra_toolsets", [])
    if extra_toolsets:
        config = yaml.safe_load(config_path.read_text()) or {}
        existing = config.get("toolsets", [])
        merged = list(dict.fromkeys(existing + extra_toolsets))  # preserve order, dedupe
        config["toolsets"] = merged
        # Also add to platform_toolsets.cli if present
        if "platform_toolsets" in config and "cli" in config["platform_toolsets"]:
            cli_tools = config["platform_toolsets"]["cli"]
            cli_merged = list(dict.fromkeys(cli_tools + extra_toolsets))
            config["platform_toolsets"]["cli"] = cli_merged
        config_path.write_text(yaml.dump(config, default_flow_style=False, sort_keys=False))
        log(f"Added extra toolsets for {name}: {extra_toolsets}", cast_name)

    # Update .env with MC_API_URL
    env_path = profile_dir / ".env"
    env_lines = []
    if env_path.exists():
        env_lines = env_path.read_text().splitlines()

    new_lines = [ln for ln in env_lines if not ln.startswith("MC_API_URL=")]
    new_lines.append(f"MC_API_URL=http://localhost:{port}")
    env_path.write_text("\n".join(new_lines) + "\n")

    # Install behavior skills
    skills_src = SCRIPT_DIR / "skills"
    skills_dst = profile_dir / "skills" / "minecraft"
    if skills_src.exists() and any(skills_src.iterdir()):
        skills_dst.mkdir(parents=True, exist_ok=True)
        for skill_file in skills_src.glob("*.md"):
            shutil.copy2(skill_file, skills_dst / skill_file.name)
        log(f"Installed behavior skills for {name}", cast_name)

    return profile_dir


# ── Bot Server ───────────────────────────────────────────────────────────────

def start_bot(
    cast_name: str,
    agent_name: str,
    port: int,
    mc_host: str = DEFAULT_MC_HOST,
    mc_port: int = DEFAULT_MC_PORT,
    workspace_dir: str | None = None,
) -> int:
    """Start the Mineflayer bot server. Returns PID."""
    lf = log_file(cast_name, agent_name, "bot")
    out = open(lf, "a")

    env = {
        **os.environ,
        "MC_HOST": mc_host,
        "MC_PORT": str(mc_port),
        "MC_USERNAME": agent_name,
        "MC_AUTH": "offline",
        "API_PORT": str(port),
        "MC_KNOWN_BOTS": _get_all_known_bots(),
    }
    if workspace_dir:
        env["WORKSPACE_DIR"] = workspace_dir
        Path(workspace_dir).mkdir(parents=True, exist_ok=True)

    log(f"Starting bot {agent_name} on port {port}...", cast_name)
    proc = subprocess.Popen(
        ["node", "server.js"],
        cwd=str(BOT_DIR),
        env=env,
        stdout=out,
        stderr=subprocess.STDOUT,
    )
    write_pid(cast_name, agent_name, "bot", proc.pid)
    log(f"Bot {agent_name} started (PID {proc.pid})", cast_name)

    # Wait for API ready -- do NOT crash if MC server is down.
    # The bot serves the dashboard even before connecting to MC,
    # so we keep it up and let it retry MC connection on its own.
    import urllib.request
    api_ready = False
    for i in range(90):  # 90s to allow MC connection timeout + API init
        time.sleep(1)
        if proc.poll() is not None:
            out.close()
            tail = lf.read_text()[-500:]
            log(f"WARNING: Bot {agent_name} exited during startup, re-launching...", cast_name)
            out = open(lf, "a")
            proc = subprocess.Popen(
                ["node", "server.js"],
                cwd=str(BOT_DIR),
                env=env,
                stdout=out,
                stderr=subprocess.STDOUT,
            )
            write_pid(cast_name, agent_name, "bot", proc.pid)
            log(f"Bot {agent_name} re-launched (PID {proc.pid})", cast_name)
            continue
        try:
            urllib.request.urlopen(f"http://localhost:{port}/health", timeout=2)
            log(f"Bot {agent_name} API ready", cast_name)
            api_ready = True
            break
        except Exception:
            pass
    if not api_ready:
        log(f"WARNING: Bot {agent_name} API not ready after 90s. MC server may be down. Dashboard should still work.", cast_name)

    return proc.pid


# ── Hermes Agent ─────────────────────────────────────────────────────────────

def start_agent(
    cast_name: str,
    agent_name: str,
    port: int,
    interval: int = 7,
    always_chat: bool = False,
    max_chat_chars: int | None = None,
) -> int:
    """Start the Hermes agent using the native persistent loop. Returns PID."""
    profile_name = agent_name.lower().replace(" ", "-")
    lf = log_file(cast_name, agent_name, "agent")
    out = open(lf, "a")

    # Use the Hermes venv Python so imports work
    hermes_venv_python = str(Path.home() / ".hermes" / "hermes-agent" / "venv" / "bin" / "python")
    agent_loop_script = str(SCRIPT_DIR / "agent_loop.py")

    standby_file = str(get_pid_dir(cast_name) / f"{agent_name}_standby")

    env = {
        **os.environ,
        "MC_API_URL": f"http://localhost:{port}",
        "MC_USERNAME": agent_name,
        "STANDBY_FILE": standby_file,
        "MC_KNOWN_BOTS": _get_all_known_bots(),
        # Enable send_message tool by telling Hermes we're on a messaging platform.
        "HERMES_SESSION_PLATFORM": "telegram",
    }
    if always_chat:
        env["MC_ALWAYS_CHAT"] = "1"
    if max_chat_chars:
        env["MC_MAX_CHAT_CHARS"] = str(max_chat_chars)

    log(f"Starting persistent agent for {agent_name}...", cast_name)
    proc = subprocess.Popen(
        [hermes_venv_python, agent_loop_script, "--profile", profile_name, "--prompt", "Begin.", "--interval", str(interval)],
        env=env,
        stdout=out,
        stderr=subprocess.STDOUT,
        stdin=subprocess.DEVNULL,
    )
    write_pid(cast_name, agent_name, "agent", proc.pid)
    log(f"Agent {agent_name} started (PID {proc.pid})", cast_name)
    return proc.pid


# ── Commands ─────────────────────────────────────────────────────────────────

def cmd_start(cast_name: str, cast: dict, mc_host: str, mc_port: int):
    agents = cast.get("agents", [])
    soul_file = None
    if "soul_file" in cast:
        soul_file = AGENTS_DIR / cast["soul_file"]
        if not soul_file.exists():
            soul_file = Path(cast["soul_file"]).resolve()

    log(f"Launching {len(agents)} agents for '{cast_name}' mode...", cast_name)

    for agent in agents:
        name = agent["name"]
        port = agent["port"]

        # Skip if already running
        bot_pid = read_pid(cast_name, name, "bot")
        agent_pid = read_pid(cast_name, name, "agent")
        if bot_pid and is_alive(bot_pid) and agent_pid and is_alive(agent_pid):
            log(f"{name} already running (bot {bot_pid}, agent {agent_pid})", cast_name)
            continue

        # 1. Setup profile
        profile_dir = setup_agent_profile(cast_name, agent, soul_file)
        workspace_dir = str(profile_dir / "workspace")

        # 2. Start bot
        start_bot(cast_name, name, port, mc_host, mc_port, workspace_dir)

        # 2b. Set gamemode if specified in cast config
        gamemode = agent.get("gamemode")
        if gamemode:
            try:
                import urllib.request
                payload = json.dumps({"message": f"/gamemode {gamemode} {name}"}).encode("utf-8")
                req = urllib.request.Request(
                    f"http://localhost:{port}/chat/send",
                    data=payload,
                    headers={"Content-Type": "application/json"},
                    method="POST",
                )
                with urllib.request.urlopen(req, timeout=5) as resp:
                    pass
                log(f"Set gamemode to {gamemode} for {name}", cast_name)
            except Exception as e:
                log(f"Warning: could not set gamemode for {name}: {e}", cast_name)

        # 3. Start agent
        always_chat = agent.get("always_chat", False)
        max_chat_chars = agent.get("max_chat_chars")
        interval = agent.get("interval", 7)
        start_agent(cast_name, name, port, interval=interval, always_chat=always_chat, max_chat_chars=max_chat_chars)

        time.sleep(2)  # Stagger to avoid resource spikes

    log(f"Cast '{cast_name}' launched.", cast_name)


def cmd_status(cast_name: str, cast: dict):
    agents = cast.get("agents", [])
    print(f"\n{'Agent':<12} {'Bot PID':<10} {'Bot OK':<8} {'Agent PID':<10} {'Agent OK':<8}")
    print("-" * 60)
    all_ok = True
    for agent in agents:
        name = agent["name"]
        bot_pid = read_pid(cast_name, name, "bot")
        agent_pid = read_pid(cast_name, name, "agent")
        bot_ok = "yes" if bot_pid and is_alive(bot_pid) else "NO"
        agent_ok = "yes" if agent_pid and is_alive(agent_pid) else "NO"
        if bot_ok == "NO" or agent_ok == "NO":
            all_ok = False
        print(f"{name:<12} {str(bot_pid or '-'):<10} {bot_ok:<8} {str(agent_pid or '-'):<10} {agent_ok:<8}")
    print()
    if all_ok:
        log(f"All {len(agents)} agents healthy.", cast_name)
    else:
        log("Some agents are not running!", cast_name)


def cmd_stop(cast_name: str, cast: dict, target_name: str | None = None):
    agents = cast.get("agents", [])
    if target_name:
        agents = [a for a in agents if a["name"].lower() == target_name.lower()]
        if not agents:
            error(f"Agent '{target_name}' not found in cast '{cast_name}'")

    for agent in agents:
        name = agent["name"]
        for kind in ("agent", "bot"):
            pid = read_pid(cast_name, name, kind)
            if pid and is_alive(pid):
                log(f"Stopping {name} {kind} (PID {pid})...", cast_name)
                try:
                    os.kill(pid, signal.SIGTERM)
                    for _ in range(50):
                        if not is_alive(pid):
                            break
                        time.sleep(0.1)
                    else:
                        os.kill(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            remove_pid(cast_name, name, kind)
        log(f"{name} stopped.", cast_name)

    if target_name:
        log(f"Agent '{target_name}' stopped.", cast_name)
    else:
        log(f"Cast '{cast_name}' stopped.", cast_name)


def cmd_logs(cast_name: str, agent_name: str, kind: str = "agent", follow: bool = False):
    lf = log_file(cast_name, agent_name, kind)
    if not lf.exists():
        error(f"No logs found for {agent_name} {kind} in cast '{cast_name}'")
    if follow:
        subprocess.run(["tail", "-f", str(lf)])
    else:
        subprocess.run(["tail", "-n", "50", str(lf)])


def cmd_restart(cast_name: str, cast: dict, mc_host: str, mc_port: int):
    log(f"Restarting cast '{cast_name}'...", cast_name)
    cmd_stop(cast_name, cast)
    time.sleep(2)
    cmd_start(cast_name, cast, mc_host, mc_port)


def cmd_pause(cast_name: str, cast: dict, target_name: str | None = None):
    """Pause autonomous turns for one or all agents (standby mode)."""
    agents = cast.get("agents", [])
    if target_name:
        agents = [a for a in agents if a["name"].lower() == target_name.lower()]
        if not agents:
            error(f"Agent '{target_name}' not found in cast '{cast_name}'")

    for agent in agents:
        name = agent["name"]
        sf = get_pid_dir(cast_name) / f"{name}_standby"
        sf.write_text("1")
        pid = read_pid(cast_name, name, "agent")
        if pid and is_alive(pid):
            try:
                os.kill(pid, signal.SIGUSR1)
            except ProcessLookupError:
                pass
        log(f"{name} paused (standby mode).", cast_name)


def cmd_resume(cast_name: str, cast: dict, target_name: str | None = None):
    """Resume autonomous turns for one or all agents."""
    agents = cast.get("agents", [])
    if target_name:
        agents = [a for a in agents if a["name"].lower() == target_name.lower()]
        if not agents:
            error(f"Agent '{target_name}' not found in cast '{cast_name}'")

    for agent in agents:
        name = agent["name"]
        sf = get_pid_dir(cast_name) / f"{name}_standby"
        sf.unlink(missing_ok=True)
        pid = read_pid(cast_name, name, "agent")
        if pid and is_alive(pid):
            try:
                os.kill(pid, signal.SIGUSR1)
            except ProcessLookupError:
                pass
        log(f"{name} resumed (autonomous mode).", cast_name)


def cmd_update(cast_name: str, cast: dict, mc_host: str, mc_port: int):
    """Hard restart: stop all agents, sync profiles with latest code, start fresh.

    Use this after editing agent_loop.py, server.js, or prompts to ensure
    changes are picked up. Unlike 'restart', this forces profile re-creation
    even if agents appear alive.
    """
    log(f"Updating cast '{cast_name}' with latest code...", cast_name)
    cmd_stop(cast_name, cast)
    time.sleep(2)
    # Force profile re-setup by removing old profile dirs
    agents = cast.get("agents", [])
    for agent in agents:
        name = agent["name"]
        profile_name = name.lower().replace(" ", "-")
        profile_dir = Path.home() / ".hermes" / "profiles" / profile_name
        if profile_dir.exists():
            # Persist plan and locations across update
            workspace_dir = profile_dir / "workspace"
            backup_dir = get_run_dir(cast_name) / "backup" / profile_name
            backup_dir.mkdir(parents=True, exist_ok=True)
            for fname in ("plan-steve.json", "locations-steve.json"):
                src = workspace_dir / fname
                if src.exists():
                    shutil.copy2(src, backup_dir / fname)
                    log(f"Saved {fname} for {name}", cast_name)
            log(f"Removing old profile for {name}...", cast_name)
            shutil.rmtree(profile_dir)
    cmd_start(cast_name, cast, mc_host, mc_port)
    # Restore persisted files
    for agent in agents:
        name = agent["name"]
        profile_name = name.lower().replace(" ", "-")
        profile_dir = Path.home() / ".hermes" / "profiles" / profile_name
        workspace_dir = profile_dir / "workspace"
        backup_dir = get_run_dir(cast_name) / "backup" / profile_name
        for fname in ("plan-steve.json", "locations-steve.json"):
            src = backup_dir / fname
            dst = workspace_dir / fname
            if src.exists():
                shutil.copy2(src, dst)
                log(f"Restored {fname} for {name}", cast_name)
    log(f"Cast '{cast_name}' updated.", cast_name)


def cmd_daemon(cast_name: str, cast: dict, mc_host: str, mc_port: int):
    """Run a supervisor loop that keeps all agents alive."""
    agents = cast.get("agents", [])
    soul_file = None
    if "soul_file" in cast:
        soul_file = AGENTS_DIR / cast["soul_file"]
        if not soul_file.exists():
            soul_file = Path(cast["soul_file"]).resolve()

    log(f"Daemon mode for '{cast_name}' started. Press Ctrl+C to stop.", cast_name)
    running = True

    def handle_sigint(signum, frame):
        nonlocal running
        running = False
        log(f"Shutting down daemon for '{cast_name}'...", cast_name)

    signal.signal(signal.SIGINT, handle_sigint)
    signal.signal(signal.SIGTERM, handle_sigint)

    while running:
        for agent in agents:
            if not running:
                break
            name = agent["name"]
            port = agent["port"]

            bot_pid = read_pid(cast_name, name, "bot")
            agent_pid = read_pid(cast_name, name, "agent")
            bot_alive = bot_pid and is_alive(bot_pid)
            agent_alive = agent_pid and is_alive(agent_pid)

            if not bot_alive:
                if bot_pid:
                    remove_pid(cast_name, name, "bot")
                log(f"Bot {name} down, restarting...", cast_name)
                try:
                    profile_dir = setup_agent_profile(cast_name, agent, soul_file)
                    workspace_dir = str(profile_dir / "workspace")
                    start_bot(cast_name, name, port, mc_host, mc_port, workspace_dir)
                except SystemExit:
                    pass

            if not agent_alive:
                if agent_pid:
                    remove_pid(cast_name, name, "agent")
                log(f"Agent {name} down, restarting...", cast_name)
                try:
                    always_chat = agent.get("always_chat", False)
                    interval = agent.get("interval", 7)
                    start_agent(cast_name, name, port, interval=interval, always_chat=always_chat)
                except SystemExit:
                    pass
                time.sleep(5)

        # Sleep 60s in 1s increments for responsive shutdown
        for _ in range(60):
            if not running:
                break
            time.sleep(1)

    log(f"Daemon for '{cast_name}' stopped.", cast_name)


# ── Commands ─────────────────────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="DaemonCraft — Minecraft Agent Cast Launcher")
    parser.add_argument("cmd", choices=["start", "stop", "status", "logs", "restart", "update", "daemon", "pause", "resume"],
                        help="Command to execute")
    parser.add_argument("cast", help="Cast name (e.g., companion, civilization, landfolk)")
    parser.add_argument("--mc-host", default=DEFAULT_MC_HOST, help="Minecraft server host")
    parser.add_argument("--mc-port", type=int, default=DEFAULT_MC_PORT, help="Minecraft server port")

    # Agent-specific args (for logs, stop, pause, resume)
    parser.add_argument("agent", nargs="?", help="Agent name (for logs, pause, resume commands)")

    # Logs-specific args
    parser.add_argument("--kind", choices=["agent", "bot"], default="agent", help="Log type")
    parser.add_argument("-f", "--follow", action="store_true", help="Follow logs (tail -f)")

    args = parser.parse_args()

    # Load cast config
    cast = load_cast(args.cast)

    if args.cmd == "start":
        cmd_start(args.cast, cast, args.mc_host, args.mc_port)
    elif args.cmd == "stop":
        cmd_stop(args.cast, cast, target_name=args.agent)
    elif args.cmd == "status":
        cmd_status(args.cast, cast)
    elif args.cmd == "logs":
        if not args.agent:
            error("logs command requires an agent name: daemoncraft.py logs <cast> <agent>")
        cmd_logs(args.cast, args.agent, args.kind, args.follow)
    elif args.cmd == "restart":
        cmd_restart(args.cast, cast, args.mc_host, args.mc_port)
    elif args.cmd == "update":
        cmd_update(args.cast, cast, args.mc_host, args.mc_port)
    elif args.cmd == "daemon":
        cmd_daemon(args.cast, cast, args.mc_host, args.mc_port)
    elif args.cmd == "pause":
        cmd_pause(args.cast, cast, target_name=args.agent)
    elif args.cmd == "resume":
        cmd_resume(args.cast, cast, target_name=args.agent)


if __name__ == "__main__":
    main()
