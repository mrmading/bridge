#!/usr/bin/env bash
# Build Bridge Mobile for iOS and install it on a paired iPhone (development signing, no App Store).
#
#   deploy/ios-install.sh [device-name-or-id]     # default: the first available paired iPhone
#
# Flutter's unsigned release build, then signed by hand with the "Bridge Mobile Dev" profile: Xcode's
# automatic signing picks a stale wildcard profile that does not list the phone. Profile id and identity
# can be overridden with BRIDGE_IOS_PROFILE / BRIDGE_IOS_IDENTITY.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"; mobile="$here/../mobile"
PROFILE_ID="${BRIDGE_IOS_PROFILE:-57828c5e-74dd-466d-a188-6dd02c9f0b64}"
IDENTITY="${BRIDGE_IOS_IDENTITY:-Apple Development: Created via API (HWQKB7Y4LB)}"
profile=""
for d in "$HOME/Library/Developer/Xcode/UserData/Provisioning Profiles" "$HOME/Library/MobileDevice/Provisioning Profiles"; do
  [[ -f "$d/$PROFILE_ID.mobileprovision" ]] && profile="$d/$PROFILE_ID.mobileprovision" && break
done
[[ -n "$profile" ]] || { echo "profile $PROFILE_ID not found" >&2; exit 1; }

device="${1:-$(xcrun devicectl list devices 2>/dev/null | awk '/available \(paired\)/ && /iPhone/ {print $3; exit}')}"
[[ -n "$device" ]] || { echo "no available paired iPhone (unlock it, same Wi-Fi or cable)" >&2; exit 1; }

cd "$mobile"
[[ "${SKIP_BUILD:-0}" == 1 ]] || flutter build ios --release --no-codesign
app="$mobile/build/ios/iphoneos/Runner.app"

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
security cms -D -i "$profile" > "$tmp/profile.plist"
/usr/libexec/PlistBuddy -x -c 'Print :Entitlements' "$tmp/profile.plist" > "$tmp/ent.plist"
cp "$profile" "$app/embedded.mobileprovision"
# inside out: frameworks and plugins first, the app last (with the profile's entitlements)
dirs=(); for d in "$app/Frameworks" "$app/PlugIns"; do [[ -d "$d" ]] && dirs+=("$d"); done
find "${dirs[@]}" -maxdepth 1 \( -name '*.framework' -o -name '*.dylib' -o -name '*.appex' \) 2>/dev/null | while read -r f; do
  codesign --force --sign "$IDENTITY" --timestamp=none "$f"
done
codesign --force --sign "$IDENTITY" --entitlements "$tmp/ent.plist" --timestamp=none "$app"
codesign --verify --deep --strict "$app"
xcrun devicectl device install app --device "$device" "$app"
echo "installed on $device"
