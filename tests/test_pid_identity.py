from agents.daemoncraft import _pid_matches_owner


def _fake_process(proc_root, pid, cmdline, environ=()):
    process = proc_root / str(pid)
    process.mkdir()
    (process / "cmdline").write_bytes(b"\0".join(part.encode() for part in cmdline) + b"\0")
    (process / "environ").write_bytes(b"\0".join(part.encode() for part in environ) + b"\0")


def test_agent_pid_requires_loop_command_and_matching_username(tmp_path):
    _fake_process(
        tmp_path,
        42,
        ["python", "agents/agent_loop.py", "--interval", "7"],
        ["MC_USERNAME=CompAII"],
    )

    assert _pid_matches_owner(42, "CompAII", "agent", tmp_path)
    assert not _pid_matches_owner(42, "Steve", "agent", tmp_path)


def test_reused_agent_pid_is_rejected(tmp_path):
    _fake_process(tmp_path, 42, ["/usr/libexec/gsd-rfkill"])

    assert not _pid_matches_owner(42, "CompAII", "agent", tmp_path)


def test_bot_pid_requires_matching_config(tmp_path):
    _fake_process(tmp_path, 42, ["node", "server.js", "--config", "/tmp/config-compaii.json"])

    assert _pid_matches_owner(42, "CompAII", "bot", tmp_path)
    assert not _pid_matches_owner(42, "Steve", "bot", tmp_path)
