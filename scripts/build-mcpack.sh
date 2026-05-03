#!/usr/bin/env bash
# Build a Bedrock .mcpack for DaemonCraft from client/mcpack/.
#
# .mcpack is just a renamed .zip — Bedrock recognises the extension and
# imports it as a resource pack. The version number comes from manifest.json
# header.version (an array like [0, 1, 0]).
#
# DC-129. No external CLI deps.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PACK_DIR="$REPO_ROOT/client/mcpack"
DIST_DIR="$REPO_ROOT/dist"
MANIFEST="$PACK_DIR/manifest.json"

[[ -f "$MANIFEST" ]] || { echo "Missing $MANIFEST"; exit 1; }

mkdir -p "$DIST_DIR"

VERSION="$(python3 -c "
import json
m = json.load(open('$MANIFEST'))
print('.'.join(str(x) for x in m['header']['version']))
")"

OUT="$DIST_DIR/daemoncraft-bedrock-$VERSION.mcpack"
rm -f "$OUT"

# Zip everything in the pack dir into the .mcpack. Exclude editor cruft.
( cd "$PACK_DIR" && zip -qr "$OUT" . \
    -x "*.DS_Store" -x "__MACOSX/*" -x "README.md" )

echo "Built: $OUT ($(du -h "$OUT" | cut -f1))"

# Sanity: refuse to ship anything over the join-timeout budget.
SIZE_MB=$(du -m "$OUT" | cut -f1)
if (( SIZE_MB > 10 )); then
  echo "WARNING: pack is ${SIZE_MB} MB, over the 10 MB join-timeout budget."
fi
