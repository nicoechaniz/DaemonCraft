#!/bin/bash
# watch-all.sh — unified real-time log viewer for the DaemonCraft stack
# Layers: [GANDY] embodied-service  [BOT] bot server.js  [LOOP] agent_loop
# Usage: ./scripts/watch-all.sh [cast_name] [agent_name]
# Default: lab CompAII

set -e

CAST="${1:-lab}"
AGENT="${2:-CompAII}"
LOG_DIR="$HOME/.local/share/daemoncraft/${CAST}/logs"

# Colors (ANSI)
RED='\033[0;31m';    GRN='\033[0;32m';    YLW='\033[1;33m'
MAG='\033[0;35m';    CYN='\033[0;36m';     GRAY='\033[0;90m'
BOLD='\033[1m';      NC='\033[0m'

# Cleanup on exit
cleanup() {
  jobs -p | xargs -r kill 2>/dev/null
  wait 2>/dev/null
}
trap cleanup EXIT INT TERM HUP

echo -e "${BOLD}=== DaemonCraft Unified Watch — ${CAST}/${AGENT} ===${NC}"
echo -e "  ${CYN}[GANDY]${NC} embodied-service (Gemma-Andy plans, tool dispatch)"
echo -e "  ${GRN}[BOT]${NC}   bot server.js (HTTP requests, mineflayer events)"
echo -e "  ${YLW}[LOOP]${NC}  agent_loop (heartbeats, guardian)"
echo -e "  ${RED}[ERR]${NC}   errors across all layers"
echo ""

# ── Layer 1: Embodied Service (journalctl) ────────
journalctl --user -u embodied-service.service -f -n 0 -o cat 2>/dev/null \
  | while IFS= read -r line; do
      if echo "$line" | grep -q '"event":"intent_received"'; then
        intent=$(echo "$line" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('intent','?')[:140])" 2>/dev/null || echo "?")
        echo -e "${CYN}[GANDY]${NC} ← intent: ${intent}"
      elif echo "$line" | grep -q '"event":"ollama_call_done"'; then
        tool_count=$(echo "$line" | python3 -c "import sys,json; d=json.load(sys.stdin); tc=d.get('plan',{}).get('tool_calls',[]); print(len(tc))" 2>/dev/null || echo "?")
        tools=$(echo "$line" | python3 -c "import sys,json; d=json.load(sys.stdin); print(', '.join(tc.get('name','?') for tc in d.get('plan',{}).get('tool_calls',[])))" 2>/dev/null || echo "?")
        echo -e "${CYN}[GANDY]${NC}   plan (${tool_count} tools): ${tools}"
      elif echo "$line" | grep -q '"event":"tool_dispatch"'; then
        tool=$(echo "$line" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('tool','?'))" 2>/dev/null || echo "?")
        ok=$(echo "$line" | python3 -c "import sys,json; d=json.load(sys.stdin); print('OK' if d.get('ok') else 'FAIL')" 2>/dev/null || echo "?")
        color="$GRN"; [ "$ok" = "FAIL" ] && color="$RED"
        echo -e "  ${color}[GANDY] → ${tool}: ${ok}${NC}"
      elif echo "$line" | grep -q '"event":"intent_done"'; then
        ok=$(echo "$line" | python3 -c "import sys,json; d=json.load(sys.stdin); print('OK' if d.get('ok') else 'FAIL')" 2>/dev/null || echo "?")
        elapsed=$(echo "$line" | python3 -c "import sys,json; d=json.load(sys.stdin); print(f\"{d.get('elapsed_seconds',0):.1f}s\")" 2>/dev/null || echo "?")
        color="$GRN"; [ "$ok" = "FAIL" ] && color="$RED"
        echo -e "  ${color}[GANDY] done (${elapsed})${NC}"
      fi
    done &

# ── Layer 2: Bot Server (log file) ─────────────────
tail -n 0 -F "${LOG_DIR}/${AGENT}_bot.log" 2>/dev/null \
  | while IFS= read -r line; do
      # Bot verbose requests
      if echo "$line" | grep -q '\[req\]'; then
        req=$(echo "$line" | sed 's/^.*\[req\] //')
        echo -e "${GRN}[BOT]${NC} REQ ${req}"
      elif echo "$line" | grep -q '\[res\]'; then
        res=$(echo "$line" | sed 's/^.*\[res\] //')
        echo -e "${GRAY}[BOT]${NC} RES ${res}"
      # Bot startup/config messages
      elif echo "$line" | grep -qE '\[config\]|\[registry\]|\[ws\]'; then
        echo -e "${GRN}[BOT]${NC} ${line}"
      # Errors
      elif echo "$line" | grep -qiE 'error|fail|exception|crash'; then
        echo -e "${RED}[ERR]${NC} ${line:0:250}"
      fi
    done &

# ── Layer 3: Agent Loop (log file) ─────────────────
tail -n 0 -F "${LOG_DIR}/${AGENT}_agent.log" 2>/dev/null \
  | while IFS= read -r line; do
      if echo "$line" | grep -qiE 'heartbeat|wake|guardian|turn|hazard'; then
        echo -e "${YLW}[LOOP]${NC} ${line:0:180}"
      elif echo "$line" | grep -qiE 'error|fail|crash|exception'; then
        echo -e "${RED}[ERR]${NC} ${line:0:250}"
      fi
    done &

# Keep alive
wait
