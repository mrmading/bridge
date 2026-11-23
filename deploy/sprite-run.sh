#!/usr/bin/env bash
# Installed by deploy/sprite.sh as /home/sprite/bridge/run.sh (the `bridge` service command).
cd /home/sprite/bridge
export BRIDGE_PORT=8080 HOME=/home/sprite PATH=/home/sprite/.bun/bin:/usr/local/bin:/usr/bin:/bin:$PATH
# secrets + auth config live outside the checkout, 600, written only by deploy/sprite.sh
if [[ -f /home/sprite/.bridge.env ]]; then set -a; . /home/sprite/.bridge.env; set +a; fi
exec bun server.ts
