#!/usr/bin/env bash
# Restart Bridge: stop every running server (the dev one from `./bridge` and the one inside
# Bridge.app), then relaunch /Applications/Bridge.app so it takes :4270. Meant to be run
# detached, since the caller may be a chat session inside the very server being restarted:
#   nohup mac/restart.sh 6 > restart.log 2>&1 &
set -u
DELAY="${1:-0}"
PORT="${BRIDGE_PORT:-4270}"
APP="/Applications/Bridge.app"
log() { echo "$(date '+%H:%M:%S') $*"; }

sleep "$DELAY"
log "stopping Bridge servers"
osascript -e 'tell application "Bridge" to quit' >/dev/null 2>&1 || true
pkill -f "Bridge.app/Contents/MacOS/Bridge" 2>/dev/null || true
pkill -f "Bridge.app/Contents/Resources/app/server.ts" 2>/dev/null || true
pkill -f "bun server.ts" 2>/dev/null || true          # the SIGTERM handler takes the voice worker down with it
for _ in $(seq 1 40); do
  lsof -tiTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 || break
  sleep 0.25
done
if lsof -tiTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  log "port $PORT still held, forcing"
  lsof -tiTCP:"$PORT" -sTCP:LISTEN | xargs kill -9 2>/dev/null || true
  sleep 0.5
fi
pkill -9 -f "stt/worker.py" 2>/dev/null || true       # nothing should be left, but a stray model is 2 GB of RAM

log "launching $APP"
open -a "$APP"
for _ in $(seq 1 120); do
  curl -sf "http://localhost:$PORT/api/bootstrap" >/dev/null 2>&1 && break
  sleep 0.5
done
if ! curl -sf "http://localhost:$PORT/api/bootstrap" >/dev/null 2>&1; then
  log "Bridge did not answer on :$PORT within 60s"
  exit 1
fi
log "up on :$PORT"
log "voice: $(curl -s "http://localhost:$PORT/api/voice/health")"
curl -s -X POST "http://localhost:$PORT/api/voice/warm" >/dev/null
log "warming the voice worker"
