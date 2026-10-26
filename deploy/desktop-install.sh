#!/usr/bin/env bash
# The cloud computer's screen: what Bridge needs to give the sprite a desktop the agent drives and the
# user watches. Installs packages only; nothing is started here. Bridge starts the desktop on demand
# (desktop.ts) and stops it when idle.
#
#   Xvfb + openbox      a virtual 1280x800 screen and a light window manager
#   x11vnc              serves that screen as VNC on 127.0.0.1 only; Bridge bridges it to /api/desktop/ws
#   xdotool + scrot     the computer tools (click, type, key, scroll, screenshot) in desktop-mcp.ts
#   Google Chrome       the visible browser; the agent drives it over CDP via Playwright MCP
#   @playwright/mcp     pinned, in ~/.bridge-desktop/mcp (no browser download: it attaches to that Chrome)
#
# Idempotent and quick when everything is present (a stamp holds this script's hash).
# Run on the sprite:  deploy/sprite.sh does it (SKIP_DESKTOP=1 skips), or by hand:
#   sprite exec -o nestor-280 -s bridge -- bash -s < deploy/desktop-install.sh
set -euo pipefail
PW_MCP_VERSION="0.0.83"
DIR="${BRIDGE_DESKTOP_HOME:-$HOME/.bridge-desktop}"
STAMP="$DIR/.installed"
src="${BASH_SOURCE[0]:-}"; self_hash="stdin"   # piped in (bash -s): never read stdin here, it IS the script
[[ -f "$src" ]] && self_hash="$(sha256sum < "$src" | cut -c1-16)"
mkdir -p "$DIR"

have_all() {
  command -v Xvfb >/dev/null && command -v openbox >/dev/null && command -v x11vnc >/dev/null &&
  command -v xdotool >/dev/null && command -v scrot >/dev/null && command -v google-chrome >/dev/null &&
  [[ -f "$DIR/mcp/node_modules/@playwright/mcp/package.json" ]] &&
  grep -q "\"version\": \"$PW_MCP_VERSION\"" "$DIR/mcp/node_modules/@playwright/mcp/package.json"
}
if have_all && [[ -f "$STAMP" ]]; then echo "desktop: already installed ($(cat "$STAMP"))"; exit 0; fi

SUDO=""; [[ "$(id -u)" == 0 ]] || SUDO="sudo -n"
export DEBIAN_FRONTEND=noninteractive
pkgs=(xvfb openbox x11vnc xdotool scrot x11-utils x11-xserver-utils fonts-liberation fonts-noto-core fonts-noto-color-emoji)
missing=(); for p in "${pkgs[@]}"; do dpkg -s "$p" >/dev/null 2>&1 || missing+=("$p"); done
if (( ${#missing[@]} )); then
  echo "desktop: apt install ${missing[*]}"
  $SUDO apt-get update -qq
  $SUDO apt-get install -y -qq --no-install-recommends "${missing[@]}" >/dev/null
fi

if ! command -v google-chrome >/dev/null; then
  [[ "$(dpkg --print-architecture)" == amd64 ]] || { echo "desktop: Google Chrome needs amd64" >&2; exit 1; }
  echo "desktop: installing Google Chrome (stable)"
  tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
  curl -fsSL -o "$tmp/chrome.deb" https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
  $SUDO apt-get install -y -qq --no-install-recommends "$tmp/chrome.deb" >/dev/null
fi

if ! grep -qs "\"version\": \"$PW_MCP_VERSION\"" "$DIR/mcp/node_modules/@playwright/mcp/package.json"; then
  echo "desktop: @playwright/mcp@$PW_MCP_VERSION"
  mkdir -p "$DIR/mcp"
  [[ -f "$DIR/mcp/package.json" ]] || echo '{"name":"bridge-desktop-mcp","private":true}' > "$DIR/mcp/package.json"
  ( cd "$DIR/mcp" && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 bun add --exact "@playwright/mcp@$PW_MCP_VERSION" >/dev/null )
fi

have_all || { echo "desktop: install incomplete" >&2; exit 1; }
echo "$(date -u +%FT%TZ) $self_hash chrome=$(google-chrome --version | awk '{print $NF}') mcp=$PW_MCP_VERSION" > "$STAMP"
echo "desktop: ready ($(cat "$STAMP"))"
