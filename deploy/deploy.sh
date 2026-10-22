#!/usr/bin/env bash
# Build the assets and deploy the `bridge` Worker. Extra args go to wrangler (e.g. --dry-run).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
"$here/build.sh"
cd "$here/worker"
wrangler deploy "$@"
