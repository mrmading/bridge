#!/usr/bin/env bash
# Assemble the Worker for one commit: the commit's public/ at / and a Flutter web build of the same
# commit at /m/, inside that commit's own deploy/worker. Never reads the working tree.
#   deploy/build.sh [commit]   → prints the worker dir to deploy from (default commit: HEAD)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
stage="$("$here/stage.sh" "${1:-HEAD}")"
worker="$stage/src/deploy/worker"
[[ -f "$worker/wrangler.jsonc" ]] || { echo "that commit has no deploy/worker" >&2; exit 1; }
dist="$worker/dist"
rm -rf "$dist"; mkdir -p "$dist/m"
cp -R "$stage/src/public/." "$dist/"
cp -R "$stage/web/." "$dist/m/"
echo "assets: $(find "$dist" -type f | wc -l | tr -d ' ') files, $(du -sh "$dist" | cut -f1) for $(cat "$stage/.done" | cut -c1-7)" >&2
echo "$worker"
