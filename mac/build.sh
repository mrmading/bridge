#!/usr/bin/env bash
# Build Bridge.app — a native macOS shell around the local Bridge server.
# No Xcode project, no dependencies: swiftc from the Command Line Tools is enough.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
OUT="${1:-$ROOT/dist}"
APP="$OUT/Bridge.app"
VERSION="$(sed -n 's/.*"version": "\([^"]*\)".*/\1/p' "$ROOT/package.json" | head -1)"
VERSION="${VERSION:-0.1.0}"

echo "→ building Bridge.app $VERSION"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/app"

swiftc -O \
  -target arm64-apple-macosx13.0 \
  -framework AppKit -framework WebKit \
  -o "$APP/Contents/MacOS/Bridge" \
  "$HERE/Bridge/main.swift" "$HERE/Bridge/Setup.swift"

cp "$ROOT/server.ts" "$APP/Contents/Resources/app/server.ts"
cp -R "$ROOT/public" "$APP/Contents/Resources/app/public"
cp "$HERE/assets/Bridge.icns" "$APP/Contents/Resources/Bridge.icns"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Bridge</string>
  <key>CFBundleDisplayName</key><string>Bridge</string>
  <key>CFBundleIdentifier</key><string>com.github.mrmading.bridge</string>
  <key>CFBundleExecutable</key><string>Bridge</string>
  <key>CFBundleIconFile</key><string>Bridge</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSHumanReadableCopyright</key><string>MIT licensed</string>
  <key>NSDesktopFolderUsageDescription</key><string>Bridge shows the folders you add so Claude Code can work in them.</string>
  <key>NSDocumentsFolderUsageDescription</key><string>Bridge shows the folders you add so Claude Code can work in them.</string>
  <key>NSDownloadsFolderUsageDescription</key><string>Bridge shows the folders you add so Claude Code can work in them.</string>
  <key>NSAppTransportSecurity</key><dict>
    <key>NSAllowsLocalNetworking</key><true/>
  </dict>
</dict></plist>
PLIST

printf 'APPL????' > "$APP/Contents/PkgInfo"

# Sign with Developer ID when one is available, so the app can be notarised and
# opened by anyone. Falls back to an ad-hoc signature for local builds.
SIGN_ID="${BRIDGE_SIGN_ID:-$(security find-identity -v -p codesigning 2>/dev/null \
  | sed -n 's/.*"\(Developer ID Application: .*\)"/\1/p' | head -1)}"
if [ -n "$SIGN_ID" ]; then
  echo "→ signing as: $SIGN_ID"
  codesign --force --options runtime --timestamp \
    --entitlements "$HERE/Bridge.entitlements" \
    --sign "$SIGN_ID" "$APP"
  codesign --verify --strict --verbose=1 "$APP" 2>&1 | sed 's/^/  /'
else
  echo "  no Developer ID found — ad-hoc signing (fine locally, not distributable)"
  codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || echo "  (codesign skipped)"
fi

echo "✓ $APP"
echo "  open $APP   ·   or drag it into /Applications"
