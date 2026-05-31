#!/bin/bash
# Restore McCompaii's standard inventory after spawn/respawn.
# Reads config/mccompaii-standard-inventory.json
#
# Usage: bash scripts/restore-mccompaii-inventory.sh [--force]
#   --force: clear existing inventory before giving (use after death/restart)
#   default: add items on top of existing inventory (rcon /give)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
CONFIG="$PROJECT_DIR/config/mccompaii-standard-inventory.json"
BOT_API="${BOT_API_URL:-http://localhost:3003}"
MC_USERNAME="${MC_USERNAME:-CompAII}"
RCON="docker exec daemoncraft-minecraft rcon-cli"

if [ ! -f "$CONFIG" ]; then
  echo "ERROR: Config not found at $CONFIG"
  exit 1
fi

FORCE=false
if [ "${1:-}" = "--force" ]; then
  FORCE=true
  echo "[restore] Force mode: clearing inventory first..."
  $RCON "clear $MC_USERNAME"
  sleep 1
fi

echo "[restore] Loading standard inventory from $CONFIG"

# ── Armor (equip directly via /item replace) ──
echo "[restore] Equipping armor..."
$RCON "item replace entity $MC_USERNAME armor.head with netherite_helmet[unbreakable={}]"
$RCON "item replace entity $MC_USERNAME armor.chest with netherite_chestplate[unbreakable={}]"
$RCON "item replace entity $MC_USERNAME armor.legs with netherite_leggings[unbreakable={}]"
$RCON "item replace entity $MC_USERNAME armor.feet with netherite_boots[unbreakable={}]"

# ── Unbreakable tools ──
echo "[restore] Giving tools..."
for tool in netherite_pickaxe netherite_axe netherite_shovel netherite_sword netherite_hoe; do
  $RCON "give $MC_USERNAME ${tool}[unbreakable={}] 1"
done

# ── Shield (offhand) ──
echo "[restore] Giving shield..."
$RCON "give $MC_USERNAME shield 1"

# ── Inventory supplies ──
echo "[restore] Giving supplies..."
# 3 stacks cooked_beef
for i in 1 2 3; do
  $RCON "give $MC_USERNAME cooked_beef 64"
done
# 3 stacks torches
for i in 1 2 3; do
  $RCON "give $MC_USERNAME torch 64"
done
# Single items
$RCON "give $MC_USERNAME white_bed 1"
$RCON "give $MC_USERNAME crafting_table 1"
$RCON "give $MC_USERNAME furnace 1"
# Building materials
$RCON "give $MC_USERNAME coal 64"
$RCON "give $MC_USERNAME cobblestone 64"
$RCON "give $MC_USERNAME oak_planks 64"
$RCON "give $MC_USERNAME dirt 64"

echo "[restore] Done. Verify with: curl -s $BOT_API/status | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get(\"data\",{}).get(\"health\"), d.get(\"data\",{}).get(\"food\"))'"
