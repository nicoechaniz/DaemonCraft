#!/usr/bin/env bash
set -euo pipefail

PACK_URL="https://inference01.altermundi.net/packs/daemoncraft-server.zip"
PACK_FILE="/tmp/daemoncraft-server.zip"
PROPS_FILE="/home/fede/REPOS/daemoncraft/server/data/server.properties"

# Build from whichever set is active
# Usage: ./scripts/generate-sha1.sh [set-name]
# Example: ./scripts/generate-sha1.sh set-01-community-commons

SET_NAME="${1:-set-01-community-commons}"
RP_DIR="/home/fede/REPOS/daemoncraft/examples/modpack-sets/$SET_NAME/java-rp"

if [ ! -d "$RP_DIR" ]; then
    echo "ERROR: RP directory not found: $RP_DIR"
    echo "Usage: $0 <set-name>"
    echo "Available sets:"
    ls -1 /home/fede/REPOS/daemoncraft/examples/modpack-sets/ | grep set-
    exit 1
fi

# Build zip
cd "$RP_DIR"
zip -rq "$PACK_FILE" pack.mcmeta assets/ pack.png 2>/dev/null || zip -rq "$PACK_FILE" pack.mcmeta assets/

# Compute SHA1
SHA1=$(sha1sum "$PACK_FILE" | awk '{print $1}')
echo "SHA1: $SHA1"

# Update server.properties
if [ -f "$PROPS_FILE" ]; then
    cp "$PROPS_FILE" "$PROPS_FILE.bak.$(date +%s)"
    sed -i "s|^resource-pack=.*|resource-pack=$PACK_URL|" "$PROPS_FILE"
    sed -i "s|^resource-pack-sha1=.*|resource-pack-sha1=$SHA1|" "$PROPS_FILE"
    echo "Updated $PROPS_FILE"
else
    echo "WARNING: $PROPS_FILE not found. Manual entry:"
    echo "resource-pack=$PACK_URL"
    echo "resource-pack-sha1=$SHA1"
fi

# Also update the Bedrock pack if present
MCPACK_DIR="/home/fede/REPOS/daemoncraft/examples/modpack-sets/$SET_NAME/bedrock-mcpack"
GEYSER_PACKS="/home/fede/REPOS/daemoncraft/server/plugins/Geyser-Spigot/packs"
if [ -d "$MCPACK_DIR" ] && [ -d "$GEYSER_PACKS" ]; then
    (cd "$MCPACK_DIR" && zip -rq daemoncraft-bedrock.mcpack manifest.json textures/ pack_icon.png 2>/dev/null || zip -rq daemoncraft-bedrock.mcpack manifest.json textures/)
    cp "$MCPACK_DIR/daemoncraft-bedrock.mcpack" "$GEYSER_PACKS/"
    echo "Copied Bedrock pack to Geyser"
fi

echo "Done. Restart the server or run 'reload' to push the new pack."
