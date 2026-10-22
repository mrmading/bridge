#!/usr/bin/env bash
# Assemble the Worker's static assets: the desktop client (public/) at /, the Flutter web build at /m/.
# BUILD_FLUTTER=1 rebuilds mobile/build/web first (needs Flutter); otherwise the existing build is used.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"; repo="$(cd "$here/.." && pwd)"
dist="$here/worker/dist"
if [[ "${BUILD_FLUTTER:-0}" == 1 ]]; then
  (cd "$repo/mobile" && flutter build web --base-href /m/ --release --no-web-resources-cdn --pwa-strategy=none)
fi
[[ -f "$repo/mobile/build/web/index.html" ]] || { echo "no Flutter web build at mobile/build/web (run with BUILD_FLUTTER=1)" >&2; exit 1; }
rm -rf "$dist"; mkdir -p "$dist/m"
cp -R "$repo/public/." "$dist/"
cp -R "$repo/mobile/build/web/." "$dist/m/"
echo "assets: $(find "$dist" -type f | wc -l | tr -d ' ') files, $(du -sh "$dist" | cut -f1) in $dist"
