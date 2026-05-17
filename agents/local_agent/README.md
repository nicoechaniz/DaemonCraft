# DaemonCraft Local Agent Runner

Self-contained Python package that drives canonical flow #4:

```
chat → LLM captain (Kimi-K2.6) → embodied_plan → embodied-service → Gemma-Andy → bot
```

## Quick Start

```bash
# 1. Install deps
pip install --user -r agents/local_agent/requirements.txt

# 2. Start embodied-service (in another terminal)
cd agents/embodied-service && npm install && node index.js

# 3. Set your Kimi API key
export KIMI_API_KEY=sk-kimi-...

# 4. Run
python3 -m agents.local_agent --character agents/prompts/landfolk/compaii.md
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `KIMI_API_KEY` | — | Kimi API key (optional if OAuth credentials exist) |
| `KIMI_MODEL` | `kimi-k2.6` | Model name |
| `BOT_API_URL` | `http://localhost:3001` | Mineflayer bot HTTP/WS |
| `EMBODIED_SERVICE_URL` | `http://localhost:7790` | Embodied service |
| `OLLAMA_URL` | `http://10.10.20.1:11434` | Ollama (health check only) |
| `POLICY_MODE` | `auto` | `auto`, `raw`, or `policy` |
| `MC_KNOWN_BOTS` | `<bot_username>` | Comma-separated bot names to ignore |
| `EMBODIED_PLAN_TIMEOUT` | `60` | Intent POST timeout |
| `KIMI_CODE_OAUTH_HOST` | `https://auth.kimi.com` | OAuth token endpoint host |

## Authentication

The runner supports two authentication methods for Kimi:

1. **API Key** (simplest): set `KIMI_API_KEY` env var or pass `--kimi-key`
2. **OAuth** (auto-refresh): run `kimi login` once to create `~/.kimi/credentials/kimi-code.json`. The runner will automatically refresh the access token when it expires using the refresh token.

If both are available, the API key takes precedence. If neither is available, the runner exits with instructions.

## CLI Flags

```
python3 -m agents.local_agent \
  --bot-url http://localhost:3001 \
  --embodied-url http://localhost:7790 \
  --kimi-key $KIMI_API_KEY \
  --model kimi-k2.6 \
  --character agents/prompts/landfolk/compaii.md \
  --cast-soul agents/SOUL-companion.md \
  --policy-mode auto \
  --heartbeat 30 \
  --history-turns 20 \
  --max-tool-rounds 8 \
  --log-level INFO
```

## Logs

- **Stdout**: one JSONL line per event (`chat_in`, `kimi_call`, `embodied_call`, `chat_out`, ...)
- **File**: `~/.local/share/daemoncraft/local-agent/<bot>/<date>.jsonl`

## Tests

```bash
cd agents/local_agent
pytest test_kimi.py test_embodied.py -v
```

## Architecture

| File | Role |
|------|------|
| `runner.py` | Main async orchestrator (boot, WS loop, LLM turn, heartbeat) |
| `kimi.py` | Raw httpx client for Kimi-K2.6 with X-Msh headers |
| `embodied.py` | Tool dispatcher: raw pass-through + GemmaPolicy + Tier 2a retry |
| `bot_io.py` | WebSocket chat consumer + HTTP helpers |
| `soul.py` | SOUL prompt composer (canonical + character) |
| `cli.py` | argparse entrypoint |
