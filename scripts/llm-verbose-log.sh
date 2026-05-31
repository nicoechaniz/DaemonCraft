#!/bin/bash
# llm-verbose-log.sh — FULL request/response log with timestamps
# Shows complete prompts, responses, and tool calls for Hermes LLM + gAndy/Ollama
# Usage: ./scripts/llm-verbose-log.sh
#
# Sources:
#   ~/.hermes/logs/gateway.log     — message routing
#   ~/.hermes/logs/agent.log       — API calls
#   Bot log                         — /agent/log + /chat/send (full text)
#   journalctl embodied-service    — gAndy Ollama calls
#   Minecraft server log            — /tell commands from McCompaii (narration)

set -e

CAST="${1:-lab}"
AGENT="${2:-CompAII}"
BOT_LOG="$HOME/.local/share/daemoncraft/${CAST}/logs/${AGENT}_bot.log"
HERMES_LOG="$HOME/.hermes/logs/agent.log"
GATEWAY_LOG="$HOME/.hermes/logs/gateway.log"
STATE_DB="$HOME/.hermes/state.db"
MC_LOG="$HOME/Projects/DaemonCraft/server/data/logs/latest.log"

# Colors
CYN='\033[0;36m'; MAG='\033[0;35m'; YLW='\033[1;33m'
GRN='\033[0;32m'; GRAY='\033[0;90m'; BOLD='\033[1m'
RED='\033[0;31m'; NC='\033[0m'

ts() { date '+%H:%M:%S'; }

cleanup() { jobs -p | xargs -r kill 2>/dev/null; wait 2>/dev/null; }
trap cleanup EXIT INT TERM HUP

echo -e "${BOLD}=== LLM Verbose Log — $(ts) ===${NC}"
echo -e "  ${MAG}[HERMES]${NC} autonomous agent   ${CYN}[GANDY]${NC} embodied Ollama"
echo ""

# ═══════════════════════════════════════════════════════
# gAndy / Ollama (journal)
# ═══════════════════════════════════════════════════════
PREVIEW=5
LAST_GANDY=$(journalctl --user -u embodied-service.service -o cat --no-pager 2>/dev/null | wc -l)
LAST_GANDY=$((LAST_GANDY - PREVIEW))
[ "$LAST_GANDY" -lt 0 ] && LAST_GANDY=0

while true; do
  CURRENT=$(journalctl --user -u embodied-service.service -o cat --no-pager 2>/dev/null | wc -l)
  if [ "$CURRENT" -gt "$LAST_GANDY" ]; then
    journalctl --user -u embodied-service.service -o cat --no-pager 2>/dev/null \
      | tail -n +$((LAST_GANDY + 1)) \
      | while IFS= read -r line; do
        event=$(echo "$line" | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); print(d.get('event',''))" 2>/dev/null || true)
        case "$event" in
          ollama_call_start)
            ts_line="$(ts)"
            cmd=$(echo "$line" | python3 -c "
import sys,json
d=json.load(sys.stdin)
p=d.get('payload',{})
print(p.get('high_level_command','?')[:500])
" 2>/dev/null)
            echo -e "${CYN}[GANDY ${ts_line}]${NC} ${BOLD}← INTENT${NC}"
            echo -e "${CYN}[GANDY]${NC}   ${cmd}"
            ;;
          ollama_call_done)
            ts_line="$(ts)"
            echo -e "${CYN}[GANDY ${ts_line}]${NC} ${BOLD}→ RESPONSE${NC}"
            echo "$line" | python3 -c "
import sys,json
d=json.load(sys.stdin)
plan=d.get('plan',{})
steps=plan.get('body_plan',[])
tc=plan.get('tool_calls',[])
print(f\"  {d.get('elapsed_ms','?')}ms risk={d.get('operational_risk','?')}\")
for s in steps:
    print(f'  ─ {s[:300]}')
if tc:
    for t in tc:
        n=t.get('name','?')
        a=json.dumps(t.get('arguments',{}))
        print(f'  tool: {n}({a[:300]})')
" 2>/dev/null | while IFS= read -r sub; do
              echo -e "${CYN}[GANDY ${ts_line}]${NC} ${sub}"
            done
            ;;
          tool_dispatch)
            ts_line="$(ts)"
            info=$(echo "$line" | python3 -c "
import sys,json
d=json.load(sys.stdin)
ok='✓' if d.get('ok') else '✗'
print(f\"{d.get('tool','?')} {ok}\")
" 2>/dev/null)
            echo -e "${CYN}[GANDY ${ts_line}]${NC}   dispatch: ${info}"
            ;;
          intent_done)
            ts_line="$(ts)"
            info=$(echo "$line" | python3 -c "
import sys,json
d=json.load(sys.stdin)
ok='✓' if d.get('ok') else '✗'
print(f\"{ok} ({d.get('elapsed_seconds',0):.1f}s)\")
" 2>/dev/null)
            echo -e "${CYN}[GANDY ${ts_line}]${NC}   done ${info}"
            ;;
          verification_log_failed)
            ;;
        esac
      done
    LAST_GANDY=$CURRENT
  fi
  sleep 1
done &

# ═══════════════════════════════════════════════════════
# Hermes LLM (gateway + agent + bot logs)
# ═══════════════════════════════════════════════════════
LAST_GW=$(($(wc -l < "$GATEWAY_LOG" 2>/dev/null || echo 0) - PREVIEW))
LAST_HL=$(($(wc -l < "$HERMES_LOG" 2>/dev/null || echo 0) - PREVIEW))
LAST_BOT=$(($(wc -l < "$BOT_LOG" 2>/dev/null || echo 0) - PREVIEW))
LAST_MC=$(($(wc -l < "$MC_LOG" 2>/dev/null || echo 0) - PREVIEW))
[ "$LAST_GW" -lt 0 ] && LAST_GW=0
[ "$LAST_HL" -lt 0 ] && LAST_HL=0
[ "$LAST_BOT" -lt 0 ] && LAST_BOT=0
[ "$LAST_MC" -lt 0 ] && LAST_MC=0

while true; do
  # ── Gateway log ──
  if [ -f "$GATEWAY_LOG" ]; then
    NEW=$(tail -n +$((LAST_GW + 1)) "$GATEWAY_LOG" 2>/dev/null)
    if [ -n "$NEW" ]; then
      echo "$NEW" | grep -i "inbound message.*daemoncraft\|Embodied world-state\|response ready.*daemoncraft\|Wake-up reason\|Heartbeat classified\|Loaded profile SOUL\|SOUL.md BEGIN\|SOUL.md END\| SOUL:\| HEARTBEAT:" 2>/dev/null | while IFS= read -r line; do
        ts_line="$(ts)"
        if echo "$line" | grep -q "Loaded profile SOUL"; then
          info=$(echo "$line" | sed 's/.*Loaded profile //' | cut -c1-120)
          echo -e "${GRAY}[HERMES ${ts_line}]${NC} soul: ${info}"
        elif echo "$line" | grep -q "SOUL.md BEGIN"; then
          echo -e "${MAG}[HERMES ${ts_line}]${NC} ${BOLD}╔═══ SOUL.md ═══╗${NC}"
        elif echo "$line" | grep -q "SOUL.md END"; then
          echo -e "${MAG}[HERMES ${ts_line}]${NC} ${BOLD}╚═══ SOUL.md END ═══╝${NC}"
        elif echo "$line" | grep -q " SOUL:"; then
          soul=$(echo "$line" | sed 's/.* SOUL: //')
          echo -e "${MAG}[HERMES]${NC} ${soul}"
        elif echo "$line" | grep -q " HEARTBEAT:"; then
          hb=$(echo "$line" | sed 's/.* HEARTBEAT: //')
          echo -e "${MAG}[HERMES]${NC} ${hb}"
        elif echo "$line" | grep -q "inbound message.*daemoncraft"; then
          msg=$(echo "$line" | sed "s/.*msg='//" | sed "s/'$//")
          echo -e "${MAG}[HERMES ${ts_line}]${NC} ${BOLD}━━━ PROMPT ━━━${NC}"
          echo -e "${MAG}[HERMES]${NC} ${msg}"
        elif echo "$line" | grep -q "Embodied world-state"; then
          chars=$(echo "$line" | grep -oP '\d+ chars' | head -1)
          echo -e "${MAG}[HERMES ${ts_line}]${NC}   + body state (${chars})"
        elif echo "$line" | grep -q "response ready.*daemoncraft"; then
          info=$(echo "$line" | sed 's/.*response ready: //' | cut -c1-120)
          echo -e "${MAG}[HERMES ${ts_line}]${NC} ${BOLD}━━━ RESPONSE ━━━${NC} ${info}"
        elif echo "$line" | grep -q "Wake-up reason:"; then
          reason=$(echo "$line" | sed 's/.*Wake-up reason: //' | cut -c1-120)
          echo -e "${GRAY}[HERMES ${ts_line}]${NC} wake: ${reason}"
        elif echo "$line" | grep -q "SYSTEM PROMPT"; then
          info=$(echo "$line" | sed 's/.*SYSTEM PROMPT: //')
          echo -e "${MAG}[HERMES ${ts_line}]${NC} ${BOLD}━━━ SYSTEM PROMPT ━━━${NC} ${info}"
        elif echo "$line" | grep -q "Heartbeat classified"; then
          hb=$(echo "$line" | sed 's/.*classified as: //' | cut -c1-30)
          echo -e "${GRAY}[HERMES ${ts_line}]${NC} heartbeat → ${hb}"
        fi
      done
      LAST_GW=$(wc -l < "$GATEWAY_LOG")
    fi
  fi

  # ── Agent log ──
  if [ -f "$HERMES_LOG" ]; then
    NEW=$(tail -n +$((LAST_HL + 1)) "$HERMES_LOG" 2>/dev/null)
    if [ -n "$NEW" ]; then
      echo "$NEW" | grep -i "API call\|Turn ended\|tool_executor.*completed" 2>/dev/null | while IFS= read -r line; do
        ts_line="$(ts)"
        if echo "$line" | grep -q "API call"; then
          call=$(echo "$line" | sed 's/.*API call //')
          echo -e "${GRAY}[HERMES ${ts_line}]${NC} api: ${call}"
        elif echo "$line" | grep -q "tool_executor.*completed"; then
          tool=$(echo "$line" | sed 's/.*tool //' | sed 's/ completed.*//')
          echo -e "${GRAY}[HERMES ${ts_line}]${NC} tool: ${tool}"
        elif echo "$line" | grep -q "Turn ended"; then
          info=$(echo "$line" | grep -oP '(model|response_len|tool_turns|reason)=\K[^ ]+' | tr '\n' ' ')
          echo -e "${MAG}[HERMES ${ts_line}]${NC} turn done: ${info}"
        fi
      done
      LAST_HL=$(wc -l < "$HERMES_LOG")
    fi
  fi

  # ── Bot log: FULL response text ──
  if [ -f "$BOT_LOG" ]; then
    NEW=$(tail -n +$((LAST_BOT + 1)) "$BOT_LOG" 2>/dev/null)
    if [ -n "$NEW" ]; then
      # /chat/send — the actual text sent to Minecraft (UNTRUNCATED)
      echo "$NEW" | grep -a '\[req-body\].*"message":.*"target":' | while IFS= read -r line; do
        ts_line="$(ts)"
        body=$(echo "$line" | sed 's/^.*\[req-body\] [^ ]* //')
        echo "$body" | python3 -c "
import sys, json
try:
    d = json.loads(sys.stdin.read())
    msg = d.get('message', '')
    target = d.get('target', '')
    if msg and 'System:' not in msg and 'Body heartbeat' not in msg:
        print(msg)
except: pass
" 2>/dev/null | while IFS= read -r text; do
          echo -e "${GRN}[CHAT ${ts_line}]${NC} ${text}"
        done
      done

      LAST_BOT=$(wc -l < "$BOT_LOG")
    fi
  fi

  # ── Minecraft server log: /tell narration ──
  if [ -f "$MC_LOG" ]; then
    NEW=$(tail -n +$((LAST_MC + 1)) "$MC_LOG" 2>/dev/null)
    if [ -n "$NEW" ]; then
      echo "$NEW" | grep "CompAII issued server command: /tell" 2>/dev/null | while IFS= read -r line; do
        ts_line="$(ts)"
        # Extract the message after "/tell world:CompAII "
        msg=$(echo "$line" | sed 's/.*\/tell world:CompAII //')
        # Skip system/steer messages
        if echo "$msg" | grep -qv "⏩ Steered\|Body heartbeat\|System:"; then
          echo -e "${GRN}[McCompaii ${ts_line}]${NC} ${msg}"
        fi
      done
      LAST_MC=$(wc -l < "$MC_LOG")
    fi
  fi

  sleep 2
done &

wait
