#!/usr/bin/env bash
# Ship Bridge to the Fly sprite: a commit, the Flutter web build, the env file, a restart, a health check.
# Idempotent: run it again with the same commit and nothing changes but the restart.
#
#   deploy/sprite.sh [commit]     # default HEAD of the local checkout (committed work only)
#   deploy/sprite.sh --check      # health check only
#   SKIP_WEB=1 deploy/sprite.sh   # leave the sprite's Flutter build as it is
#
# Going public is a separate, deliberate step (not done here):
#   sprite config update -o nestor-280 -s bridge --url-auth public
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"; repo="$(cd "$here/.." && pwd)"
ORG="${SPRITE_ORG:-nestor-280}"; NAME="${SPRITE_NAME:-bridge}"; BRANCH="${SPRITE_BRANCH:-friendly-ux}"
SECRETS="${SECRETS_FILE:-$HOME/.claude/.env}"
SUPABASE_URL="${BRIDGE_SUPABASE_URL:-https://tozuyautmztgolnzgwvg.supabase.co}"
SUPABASE_KEY="${BRIDGE_SUPABASE_KEY:-sb_publishable_jUP3eIb6TYedA8NRIvDBrQ_oj2wKJ-7}"
ALLOWED="${BRIDGE_ALLOWED_EMAILS:-nestor@thepadelsociety.co,madingmr@gmail.com}"
QWEN_ENDPOINT="${RUNPOD_QWEN_ENDPOINT:-6fs36o7hccccvo}"
SPRITE="${SPRITE_BIN:-$(command -v sprite || echo "$HOME/.local/bin/sprite")}"
sx() { "$SPRITE" exec -o "$ORG" -s "$NAME" -- bash -c "$1"; }

check() {
  echo "health: waiting for the server…"
  sx 'for i in $(seq 1 40); do curl -sf -m 3 localhost:8080/api/authconfig >/dev/null && break; sleep 1; done
      cfg=$(curl -s -m 5 localhost:8080/api/authconfig); home=$(curl -s -o /dev/null -w "%{http_code}" -m 5 localhost:8080/api/home)
      echo "  /api/authconfig -> $cfg"; echo "  /api/home (no token) -> $home"
      echo "$cfg" | grep -q "\"required\":true" && [ "$home" = 401 ]' \
    && echo "health: OK (gate on)" || { echo "health: FAILED (gate not proven; do NOT make the URL public)" >&2; return 1; }
}
if [[ "${1:-}" == "--check" ]]; then check; exit; fi

commit="$(git -C "$repo" rev-parse --verify "${1:-HEAD}^{commit}")"
echo "commit: $commit ($(git -C "$repo" log -1 --format=%s "$commit"))"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT

# 1. code: bundle just what the sprite lacks (its HEAD if we know it, else everything) and check it out
have="$(sx 'cd ~/bridge && git rev-parse HEAD' 2>/dev/null || true)"
git -C "$repo" update-ref refs/deploy/sprite "$commit"
if [[ -n "$have" ]] && git -C "$repo" merge-base --is-ancestor "$have" "$commit" 2>/dev/null && [[ "$have" != "$commit" ]]; then
  git -C "$repo" bundle create "$tmp/x.bundle" refs/deploy/sprite "^$have"
elif [[ "$have" == "$commit" ]]; then
  : # already there
else
  git -C "$repo" bundle create "$tmp/x.bundle" refs/deploy/sprite
fi
if [[ -f "$tmp/x.bundle" ]]; then
  "$SPRITE" exec -o "$ORG" -s "$NAME" -- bash -c 'cat > /tmp/x.bundle' < "$tmp/x.bundle"
  sx "cd ~/bridge && git fetch -q /tmp/x.bundle refs/deploy/sprite && rm -f /tmp/x.bundle"
fi
sx "cd ~/bridge && git checkout -q -f -B $BRANCH $commit && git log -1 --oneline"

# 2. the Flutter web build (not in git)
if [[ "${SKIP_WEB:-0}" != 1 ]]; then
  [[ -f "$repo/mobile/build/web/index.html" ]] || { echo "no mobile/build/web; build it or SKIP_WEB=1" >&2; exit 1; }
  tar -C "$repo/mobile/build/web" -czf "$tmp/web.tgz" .
  "$SPRITE" exec -o "$ORG" -s "$NAME" -- bash -c 'd=~/bridge/mobile/build/web; rm -rf "$d.new" && mkdir -p "$d.new" && tar -xzf - -C "$d.new" && rm -rf "$d" && mv "$d.new" "$d" && echo "web: $(find "$d" -type f | wc -l) files"' < "$tmp/web.tgz"
fi

# 3. env: secrets read from the canonical file by name, sent over stdin, never printed or put in argv
qwen_key="$(grep -E '^(export )?RUNPOD_QWEN_API_KEY=' "$SECRETS" | tail -1 | sed -E 's/^(export )?RUNPOD_QWEN_API_KEY=//; s/^["'\'']//; s/["'\'']$//')"
[[ -n "$qwen_key" ]] || echo "warning: RUNPOD_QWEN_API_KEY not found in $SECRETS; Qwen will be off" >&2
{
  printf 'BRIDGE_SUPABASE_URL=%q\n' "$SUPABASE_URL"
  printf 'BRIDGE_SUPABASE_KEY=%q\n' "$SUPABASE_KEY"
  printf 'BRIDGE_ALLOWED_EMAILS=%q\n' "$ALLOWED"
  printf 'RUNPOD_QWEN_ENDPOINT=%q\n' "$QWEN_ENDPOINT"
  [[ -n "$qwen_key" ]] && printf 'RUNPOD_QWEN_API_KEY=%q\n' "$qwen_key"
} | "$SPRITE" exec -o "$ORG" -s "$NAME" -- bash -c 'umask 077; cat > ~/.bridge.env.new && chmod 600 ~/.bridge.env.new && mv ~/.bridge.env.new ~/.bridge.env && echo "env: $(cut -d= -f1 ~/.bridge.env | tr "\n" " ")($(stat -c %a ~/.bridge.env))"'
unset qwen_key

# 4. run.sh that sources the env, then restart
"$SPRITE" exec -o "$ORG" -s "$NAME" -- bash -c 'cat > ~/bridge/run.sh && chmod 755 ~/bridge/run.sh' < "$here/sprite-run.sh"
sx 'sprite-env services restart bridge >/dev/null && echo "restarted"'
check
