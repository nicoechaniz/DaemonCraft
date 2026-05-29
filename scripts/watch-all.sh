#!/bin/bash
# watch-all.sh — unified real-time log viewer for the DaemonCraft stack
# Layers: [GANDY] embodied-service  [BOT] bot server.js  [LOOP] agent_loop  [LLM] autonomous session
# Usage: ./scripts/watch-all.sh [cast_name] [agent_name]
# Default: lab CompAII

set -e

CAST="${1:-lab}"
AGENT="${2:-CompAII}"
LOG_DIR="$HOME/.local/share/daemoncraft/${CAST}/logs"

# Colors (ANSI)
RED='\033[0;31m';    GRN='\033[0;32m';    YLW='\033[1;33m'
MAG='\033[0;35m';    CYN='\033[0;36m';    BLU='\033[0;34m'
GRAY='\033[0;90m';   BOLD='\033[1m';      NC='\033[0m'

# Cleanup on exit
cleanup() {
  jobs -p | xargs -r kill 2>/dev/null
  wait 2>/dev/null
}
trap cleanup EXIT INT TERM HUP

echo -e "${BOLD}=== DaemonCraft Unified Watch — ${CAST}/${AGENT} ===${NC}"
echo -e "  ${CYN}[GANDY]${NC} embodied-service (Gemma-Andy plans, tool dispatch)"
echo -e "  ${GRN}[BOT]${NC}   bot server.js (HTTP requests, mineflayer events)"
echo -e "  ${YLW}[LOOP]${NC}  agent_loop (heartbeats, guardian, actions)"
echo -e "  ${MAG}[LLM]${NC}   autonomous LLM (wake-up prompts, decisions)"
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
      if echo "$line" | grep -q '\[motion\]'; then
        m=$(echo "$line" | sed 's/^.*\[motion\] //')
        echo -e "${MAG}[MOTN]${NC} ${m}"
      elif echo "$line" | grep -q '\[mineflayer\]'; then
        mf=$(echo "$line" | sed 's/^.*\[mineflayer\] //')
        echo -e "${BLU}[MFLY]${NC} ${mf}"
      elif echo "$line" | grep -q '\[PATHFINDER\]'; then
        pf=$(echo "$line" | sed 's/^.*\[PATHFINDER\] //')
        echo -e "${CYN}[PATH]${NC} ${pf}"
      elif echo "$line" | grep -q '\[req-body\]'; then
        body=$(echo "$line" | sed 's/^.*\[req-body\] //')
        echo -e "${GRAY}[BOT]${NC} BODY ${body}"
      elif echo "$line" | grep -q '\[req\]'; then
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
      if echo "$line" | grep -qiE 'heartbeat|wake|guardian|turn|hazard|ACTION|LLM|RAPID'; then
        echo -e "${YLW}[LOOP]${NC} ${line:0:250}"
      elif echo "$line" | grep -qiE 'error|fail|crash|exception'; then
        echo -e "${RED}[ERR]${NC} ${line:0:250}"
      fi
    done &

# ── Layer 4: LLM Autonomous Decisions (gateway log + agent log) ──
HERMES_LOG="$HOME/.hermes/logs/agent.log"
GATEWAY_LOG="$HOME/.hermes/logs/gateway.log"
PREVIEW=30  # Lines to show on startup (avoid replaying entire log history)

# Track last seen position — start near the end so we only show recent history
LAST_GW=$(($(wc -l < "$GATEWAY_LOG" 2>/dev/null || echo 0) - PREVIEW))
LAST_AG=$(($(wc -l < "$HERMES_LOG" 2>/dev/null || echo 0) - PREVIEW))
[ "$LAST_GW" -lt 0 ] && LAST_GW=0
[ "$LAST_AG" -lt 0 ] && LAST_AG=0

while true; do
  # Gateway: show wake-up prompts and heartbeat classifications
  if [ -f "$GATEWAY_LOG" ]; then
    NEW_LINES=$(tail -n +$((LAST_GW + 1)) "$GATEWAY_LOG" 2>/dev/null)
    if [ -n "$NEW_LINES" ]; then
      echo "$NEW_LINES" | grep -i "daemoncraft.*wake-up\|Heartbeat classified\|Wake-up reason\|chat.*queued\|agent_response" 2>/dev/null | while IFS= read -r line; do
        # Extract meaningful parts
        if echo "$line" | grep -q "Wake-up reason:"; then
          reason=$(echo "$line" | sed 's/.*Wake-up reason: //' | cut -c1-120)
          echo -e "${MAG}[LLM]${NC} wake: ${reason}"
        elif echo "$line" | grep -q "Heartbeat classified as:"; then
          hb=$(echo "$line" | sed 's/.*classified as: //' | cut -c1-40)
          echo -e "${MAG}[LLM]${NC} heartbeat → ${hb}"
        elif echo "$line" | grep -q "inbound message.*daemoncraft"; then
          msg=$(echo "$line" | sed "s/.*msg='//" | sed "s/'$//" | cut -c1-150)
          echo -e "${MAG}[LLM]${NC} prompt: ${msg}..."
        fi
      done
      LAST_GW=$(wc -l < "$GATEWAY_LOG")
    fi
  fi

  # Agent log: show tool calls from autonomous session
  if [ -f "$HERMES_LOG" ]; then
    NEW_LINES=$(tail -n +$((LAST_AG + 1)) "$HERMES_LOG" 2>/dev/null)
    if [ -n "$NEW_LINES" ]; then
      echo "$NEW_LINES" | grep -i "tool_executor\|conversation_loop: API" 2>/dev/null | grep -v "20260529_165725" | while IFS= read -r line; do
        if echo "$line" | grep -q "tool_executor.*completed"; then
          tool=$(echo "$line" | sed 's/.*tool //' | sed 's/ completed.*//' | cut -c1-60)
          echo -e "${MAG}[LLM]${NC} tool: ${tool}"
        elif echo "$line" | grep -q "API call"; then
          call=$(echo "$line" | sed 's/.*API call //' | cut -c1-80)
          echo -e "${GRAY}[LLM]${NC}   ${call}"
        fi
      done
      LAST_AG=$(wc -l < "$HERMES_LOG")
    fi
  fi
  sleep 2
done &

# Keep alive
wait
