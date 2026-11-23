#!/usr/bin/env bash
# Stage one commit for shipping: its tree (git archive, never the working tree) plus a Flutter web
# build made from that same tree. Cached per commit, so a second call is instant.
#   deploy/stage.sh [commit]   → prints the stage dir: <dir>/src (the commit's files), <dir>/web (Flutter build for /m/)
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
commit="$(git -C "$repo" rev-parse --verify "${1:-HEAD}^{commit}")"
cache="${BRIDGE_STAGE_CACHE:-$HOME/Library/Caches/bridge-deploy}"
dir="$cache/$commit"
if [[ -f "$dir/.done" ]]; then echo "$dir"; exit 0; fi
rm -rf "$dir"; mkdir -p "$dir/src"
git -C "$repo" archive "$commit" | tar -x -C "$dir/src"
[[ -f "$dir/src/mobile/pubspec.yaml" ]] || { echo "commit $commit has no mobile/ app" >&2; exit 1; }
echo "stage: flutter build web at ${commit:0:7} (a few minutes)…" >&2
( cd "$dir/src/mobile" && flutter pub get >&2 \
  && flutter build web --base-href /m/ --release --no-web-resources-cdn --pwa-strategy=none >&2 )
mv "$dir/src/mobile/build/web" "$dir/web"
rm -rf "$dir/src/mobile/build" "$dir/src/mobile/.dart_tool"
echo "$commit" > "$dir/.done"
echo "$dir"
