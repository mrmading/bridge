#!/usr/bin/env bash
# Deploy the `bridge` Worker built from one commit (worker code, public/ and Flutter build all from it).
#   deploy/deploy.sh [commit] [wrangler args…]   e.g. deploy/deploy.sh 07cb824 --dry-run
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
ref="HEAD"; [[ $# -gt 0 && "$1" != -* ]] && { ref="$1"; shift; }
commit="$(git -C "$here/.." rev-parse --verify "$ref^{commit}")"
[[ "$ref" == HEAD && -n "$(git -C "$here/.." status --porcelain -- public mobile/lib deploy)" ]] \
  && echo "note: shipping HEAD ${commit:0:7}; uncommitted changes are NOT included" >&2
worker="$("$here/build.sh" "$commit")"
cd "$worker"
wrangler deploy --message "bridge ${commit:0:12}" "$@"
