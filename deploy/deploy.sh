#!/usr/bin/env bash
# Deploy the `bridge` Worker built from one commit (worker code, public/ and Flutter build all from it).
#   deploy/deploy.sh [commit] [wrangler args…]   e.g. deploy/deploy.sh 07cb824 --dry-run
# Fails loudly: wrangler can report an error and still exit 0, so success means the new version is current.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
ref="HEAD"; [[ $# -gt 0 && "$1" != -* ]] && { ref="$1"; shift; }
commit="$(git -C "$here/.." rev-parse --verify "$ref^{commit}")"
[[ "$ref" == HEAD && -n "$(git -C "$here/.." status --porcelain -- public mobile/lib deploy)" ]] \
  && echo "note: shipping HEAD ${commit:0:7}; uncommitted changes are NOT included" >&2
worker="$("$here/build.sh" "$commit")"
msg="bridge ${commit:0:12}"
# the staged dir sits outside any package, so wrangler would hunt upward for node_modules/.cache
# (and hit a root-owned ~/node_modules): give it its own cache next to the stage
export WRANGLER_CACHE_DIR="$worker/.wrangler/cache"; mkdir -p "$WRANGLER_CACHE_DIR"
cd "$worker"
log="$(mktemp)"; trap 'rm -f "$log"' EXIT
set +e
wrangler deploy --cwd "$worker" --config "$worker/wrangler.jsonc" --message "$msg" "$@" 2>&1 | tee "$log"
rc=${PIPESTATUS[0]}
set -e
if (( rc != 0 )) || grep -q '\[ERROR\]' "$log"; then echo "deploy FAILED (exit $rc)" >&2; exit 1; fi
for a in "$@"; do [[ "$a" == --dry-run ]] && exit 0; done
grep -q 'Current Version ID' "$log" || { echo "deploy FAILED: no version reported" >&2; exit 1; }
# the list runs oldest → newest; the last block (from its column-0 "Created:") is the live deployment
current="$(wrangler deployments list --config "$worker/wrangler.jsonc" 2>/dev/null | awk '/^Created:/{b=""} {b=b $0 "\n"} END{printf "%s", b}')"
[[ "$current" == *"$msg"* ]] || { echo "deploy FAILED: '$msg' is not the current deployment:" >&2; echo "$current" >&2; exit 1; }
echo "deployed: $msg is current"
