#!/usr/bin/env bash
# Build a drag-to-Applications disk image for people who do not use a terminal.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
OUT="$ROOT/dist"
VERSION="$(sed -n 's/.*"version": "\([^"]*\)".*/\1/p' "$ROOT/package.json" | head -1)"
VERSION="${VERSION:-0.1.0}"
DMG="$OUT/Bridge-$VERSION.dmg"
STAGE="$OUT/.dmg-stage"

"$HERE/build.sh" "$OUT"

echo "→ packaging Bridge-$VERSION.dmg"
rm -rf "$STAGE" "$DMG"
mkdir -p "$STAGE"
cp -R "$OUT/Bridge.app" "$STAGE/Bridge.app"
ln -s /Applications "$STAGE/Applications"

cat > "$STAGE/Read me first.txt" <<'TXT'
Bridge — a desktop client for Claude Code
=========================================

1. Drag Bridge into the Applications folder next to it.
2. Open Applications and double-click Bridge.
   The first time, macOS may say the app is from an unidentified developer:
   right-click Bridge, choose Open, then Open again. You only do this once.
3. Bridge checks whether the two free tools it needs are on your Mac
   (Bun, and Anthropic's Claude Code) and offers to install anything missing.
   It will also ask whether you use LifeOS. All of that is optional and
   nothing is installed without you pressing the button.

That is the whole setup. Bridge keeps everything on your machine.

https://github.com/mrmading/bridge
TXT

hdiutil create -volname "Bridge" -srcfolder "$STAGE" -ov -format UDZO -quiet "$DMG"
rm -rf "$STAGE"

# give the image the app's icon
if command -v sips >/dev/null && [ -f "$HERE/assets/Bridge.icns" ]; then
  python3 - "$DMG" "$HERE/assets/Bridge.icns" <<'PY' 2>/dev/null || true
import subprocess, sys
dmg, icns = sys.argv[1], sys.argv[2]
subprocess.run(["/usr/bin/osascript", "-e", f'''
  use framework "AppKit"
  set img to current application's NSImage's alloc()'s initWithContentsOfFile:"{icns}"
  current application's NSWorkspace's sharedWorkspace()'s setIcon:img forFile:"{dmg}" options:0
'''], check=False)
PY
fi

echo "✓ $DMG  ($(du -h "$DMG" | cut -f1))"
