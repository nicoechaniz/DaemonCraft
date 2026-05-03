#!/usr/bin/env bash
# Build a Modrinth .mrpack for DaemonCraft from client/mrpack/manifest.toml.
#
# Resolves each pinned (slug, version_id) to the Modrinth file URL + sha1/sha512,
# emits modrinth.index.json with per-file path/hashes/downloads/size, copies
# overrides/, zips into dist/daemoncraft-<version>.mrpack.
#
# DC-128. No external CLI deps beyond curl + python3.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PACK_DIR="$REPO_ROOT/client/mrpack"
DIST_DIR="$REPO_ROOT/dist"
MANIFEST="$PACK_DIR/manifest.toml"

[[ -f "$MANIFEST" ]] || { echo "Missing $MANIFEST"; exit 1; }

mkdir -p "$DIST_DIR"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/overrides"

# Copy overrides if present (configs, servers.dat, etc.)
if [[ -d "$PACK_DIR/overrides" ]] && compgen -G "$PACK_DIR/overrides/*" > /dev/null; then
  cp -r "$PACK_DIR/overrides/." "$WORK/overrides/"
fi

# Resolve manifest -> modrinth.index.json via Python (uses urllib + tomllib).
python3 - "$MANIFEST" "$WORK/modrinth.index.json" <<'PY'
import json, sys, tomllib, urllib.request

manifest_path, out_path = sys.argv[1], sys.argv[2]
with open(manifest_path, "rb") as f:
    m = tomllib.load(f)

def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": "daemoncraft-build-mrpack/0.1"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())

files = []

def resolve(slug, vid, kind):
    # kind: "mod" -> mods/<file>, "resourcepack" -> resourcepacks/<file>
    info = fetch(f"https://api.modrinth.com/v2/version/{vid}")
    for fobj in info["files"]:
        if fobj.get("primary"):
            target = fobj
            break
    else:
        target = info["files"][0]
    fname = target["filename"]
    folder = "mods" if kind == "mod" else "resourcepacks"
    files.append({
        "path": f"{folder}/{fname}",
        "hashes": {
            "sha1": target["hashes"]["sha1"],
            "sha512": target["hashes"]["sha512"],
        },
        "env": {"client": "required", "server": "unsupported" if kind == "resourcepack" else "required"},
        "downloads": [target["url"]],
        "fileSize": target["size"],
    })
    print(f"  resolved {slug:30s} -> {fname}", file=sys.stderr)

for entry in m.get("mods", []):
    resolve(entry["slug"], entry["version_id"], "mod")
for entry in m.get("resourcepacks", []):
    resolve(entry["slug"], entry["version_id"], "resourcepack")

# Resolve fabric-loader latest stable from the loader API.
loader_ver = m.get("loader_version", "latest")
if loader_ver == "latest":
    versions = fetch("https://meta.fabricmc.net/v2/versions/loader")
    loader_ver = next(v["version"] for v in versions if v.get("stable"))

index = {
    "formatVersion": 1,
    "game": "minecraft",
    "versionId": m["meta"]["version"],
    "name": m["meta"]["name"],
    "summary": m["meta"].get("summary", ""),
    "files": files,
    "dependencies": {
        "minecraft": m["minecraft"],
        "fabric-loader": loader_ver,
    },
}
with open(out_path, "w") as f:
    json.dump(index, f, indent=2, sort_keys=True)
print(f"  fabric-loader pinned to {loader_ver}", file=sys.stderr)
print(f"  {len(files)} files in pack", file=sys.stderr)
PY

VERSION="$(python3 -c "import tomllib; print(tomllib.load(open('$MANIFEST','rb'))['meta']['version'])")"
OUT="$DIST_DIR/daemoncraft-$VERSION.mrpack"
( cd "$WORK" && zip -qr "$OUT" modrinth.index.json overrides )

echo
echo "Built: $OUT ($(du -h "$OUT" | cut -f1))"
