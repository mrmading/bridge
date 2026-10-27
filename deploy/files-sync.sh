#!/usr/bin/env bash
# One-way, incremental file sync: this Mac -> the Fly sprite. Sends every file under the scope roots
# that changed since the last successful run, as tar streams through `sprite exec` (no rsync/ssh there).
# Paths travel relative to $HOME and unpack under the sprite's $HOME (/home/sprite, which
# /Users/mrmading links to, so absolute paths match). Unpacking through that link instead makes GNU tar's
# --keep-newer-files stat fail (EXDEV) and silently skip every file.
#
#   deploy/files-sync.sh             # sync what changed since the stamp (first run: since 2026-10-20)
#   deploy/files-sync.sh --dry-run   # list what would go (counts and MB), send nothing
#
# Rules: never deletes on the sprite; never sends secrets (.env*, .credentials*, keys, .dev.vars);
# skips build output, dependencies, caches, venvs and Bridge's own agent worktrees (.claude/worktrees).
# A file already on the sprite that is NEWER than the Mac's copy is left alone (tar --keep-newer-files),
# so a sprite-side edit is only overwritten when the Mac copy changed after it.
# Batches are sent oldest-first; on a failure the stamp advances only past the batches that landed,
# so nothing is lost and the next run resumes there. Last stdout line is a one-line summary.
set -uo pipefail
export COPYFILE_DISABLE=1   # no AppleDouble ._ files in the stream

ORG="${SPRITE_ORG:-nestor-280}"; NAME="${SPRITE_NAME:-bridge}"
SPRITE="${SPRITE_BIN:-$HOME/.local/bin/sprite}"
STATE="${FILES_SYNC_DIR:-$HOME/.claude/bridge}"
STAMP="$STATE/files-sync.stamp"; LOCK="$STATE/files-sync.lock"
FIRST="${FILES_SYNC_SINCE:-202610200000}"            # touch -t format, used when no stamp yet
BATCH_MB="${FILES_SYNC_BATCH_MB:-200}"; BATCH_FILES="${FILES_SYNC_BATCH_FILES:-6000}"
MAX_FILE_MB="${FILES_SYNC_MAX_FILE_MB:-1024}"        # a single file larger than this is skipped (logged)
DRY=0; [[ "${1:-}" == "--dry-run" ]] && DRY=1
if [[ -n "${FILES_SYNC_ROOTS:-}" ]]; then read -r -a ROOTS <<< "$FILES_SYNC_ROOTS"
else ROOTS=("$HOME/Desktop/Cowork" "$HOME/setpoint"); fi

mkdir -p "$STATE"
# one run at a time (the Bridge timer and a manual run must not overlap)
if ! mkdir "$LOCK" 2>/dev/null; then
  pid="$(cat "$LOCK/pid" 2>/dev/null || true)"
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then echo "files-sync: already running (pid $pid)"; exit 0; fi
  rm -rf "$LOCK"; mkdir "$LOCK" || { echo "files-sync: cannot take lock $LOCK"; exit 1; }
fi
echo $$ > "$LOCK/pid"
work="$(mktemp -d)"; trap 'rm -rf "$work" "$LOCK"' EXIT

[[ -f "$STAMP" ]] || touch -t "$FIRST" "$STAMP"
touch "$work/start"                       # becomes the stamp when every batch lands
since="$(date -r "$(stat -f %m "$STAMP")" '+%Y-%m-%d %H:%M:%S')"
t0=$(date +%s)

roots=(); for r in "${ROOTS[@]}"; do [[ -d "$r" && "$r" == "$HOME"/* ]] && roots+=("$r"); done
[[ ${#roots[@]} -gt 0 ]] || { echo "files-sync: no roots found"; exit 1; }

# Directories never descended into. .git stays (repos must stay coherent on the sprite).
PRUNE_DIRS=(node_modules build .dart_tool Pods target .next dist .turbo .cache __pycache__ .pytest_cache
  .mypy_cache .ruff_cache .parcel-cache .svelte-kit .vercel .wrangler .expo .gradle DerivedData .fvm
  .venv venv .virtualenv .tox .pub-cache .Trash .credentials '.credentials*' .symlinks .sass-cache)
prune=( \( ); first=1
for d in "${PRUNE_DIRS[@]}"; do [[ $first == 1 ]] || prune+=( -o ); prune+=( -name "$d" ); first=0; done
prune+=( -o -path '*/.claude/worktrees' -o -path '*/.git/lfs/tmp' \) -prune )
# Files never sent: secrets, OS litter, git lock files (a stray index.lock would wedge the sprite's repo).
SKIP_FILES=( \( -name '.env' -o -name '.env.*' -o -name '.env*' -o -name '.credentials*' -o -name '*.pem'
  -o -name '*.p8' -o -name '*.key' -o -name '*.p12' -o -name '*.pfx' -o -name '*.jks' -o -name '*.keystore'
  -o -name '.dev.vars*' -o -name 'id_rsa*' -o -name 'id_ed25519*' -o -name '.DS_Store' -o -name '._*'
  -o -name '*.sock' -o \( -path '*/.git/*' -name '*.lock' \) \) )

# mtime<TAB>size<TAB>path, oldest first; paths containing a newline are skipped (tar -T is line-based)
find "${roots[@]}" "${prune[@]}" -o \( -type f -o -type l \) -newer "$STAMP" ! "${SKIP_FILES[@]}" \
  -exec stat -f '%m%t%z%t%N' {} + 2>/dev/null | sort -t $'\t' -k1,1n > "$work/all"

max=$((MAX_FILE_MB * 1024 * 1024))
awk -F'\t' -v home="$HOME" -v max="$max" -v bmb="$BATCH_MB" -v bfiles="$BATCH_FILES" -v dir="$work" '
  NF < 3 { next }
  { path = $3; for (i = 4; i <= NF; i++) path = path "\t" $i }
  $2 > max { print path > (dir "/skipped"); skipped++; next }
  {
    if (n == 0 || bytes + $2 > bmb * 1048576 || cnt >= bfiles) { n++; bytes = 0; cnt = 0 }
    bytes += $2; cnt++; tot += $2; files++
    path = substr(path, length(home) + 2); print path > (dir "/b" n ".list")
    if (!(n in firstm)) { firstm[n] = $1; print n "\t" $1 > (dir "/batches") }
  }
  END { printf "%d %d %d %d\n", files, tot, n, skipped > (dir "/totals") }' "$work/all"
read -r files bytes nb skipped < "$work/totals"
mb=$(awk -v b="$bytes" 'BEGIN { printf "%.1f", b / 1048576 }')
[[ $skipped -gt 0 ]] && echo "files-sync: skipped $skipped file(s) over ${MAX_FILE_MB} MB: $(head -3 "$work/skipped" | tr '\n' ' ')" >&2

if [[ $DRY == 1 ]]; then
  [[ -n "${FILES_SYNC_LIST:-}" ]] && cp "$work/all" "$FILES_SYNC_LIST"
  echo "files-sync: dry run since $since: $files files, $mb MB, $nb batches"; exit 0
fi
if [[ $files -eq 0 ]]; then
  mv "$work/start" "$STAMP"; echo "files-sync: 0 files, 0.0 MB, $(( $(date +%s) - t0 ))s (since $since)"; exit 0
fi

# Extract on the sprite. --keep-newer-files: never clobber a sprite copy newer than ours.
# A whole stream that unpacked with a few per-file errors (e.g. a path that is a folder there) counts as
# landed, errors reported; a broken stream (truncated, bad gzip) does not, and is retried.
REMOTE='e=$(mktemp); tar -xzf - -C "$HOME" --keep-newer-files --no-same-owner --warning=no-unknown-keyword --warning=no-ignore-newer 2>"$e"; c=$?
if grep -qE "Unexpected EOF|not in gzip format|invalid compressed data|not recoverable|Archive is compressed|Cannot stat" "$e"; then tail -5 "$e" >&2
elif [ $c = 0 ]; then echo LANDED
else echo "LANDED with $(wc -l < "$e") file error(s)"; tail -3 "$e" >&2; fi; rm -f "$e"'
send() { # $1 = batch list file; prints LANDED on success
  tar -czf - --no-xattrs --no-mac-metadata --no-fflags -C "$HOME" -T "$1" 2>>"$work/tar.err" \
    | "$SPRITE" exec -o "$ORG" -s "$NAME" -- bash -c "$REMOTE" 2>>"$work/remote.err"
}

done_files=0; errs=0; failed=0
while IFS=$'\t' read -r n firstm <&3; do
  list="$work/b$n.list"; ok=0
  for attempt in 1 2; do
    out="$(send "$list")"
    if [[ "$out" == LANDED* ]]; then ok=1
      [[ "$out" =~ with\ ([0-9]+) ]] && errs=$((errs + BASH_REMATCH[1])); break; fi
    sleep 5
  done
  if [[ $ok == 0 ]]; then failed=$n
    # everything older than this batch landed: move the stamp to just before it
    touch -t "$(date -r $((firstm - 1)) '+%Y%m%d%H%M.%S')" "$STAMP"
    break
  fi
  done_files=$((done_files + $(wc -l < "$list")))
done 3< "$work/batches"

secs=$(( $(date +%s) - t0 ))
note=""; [[ $errs -gt 0 ]] && note=", $errs file error(s): $(tail -c 200 "$work/remote.err" | tr '\n' ' ')"
if [[ $failed == 0 ]]; then
  mv "$work/start" "$STAMP"
  echo "files-sync: $files files, $mb MB, ${secs}s, $nb batch(es) (since $since)$note"
else
  echo "files-sync: FAILED at batch $failed/$nb after $done_files of $files files, ${secs}s: $(tail -c 300 "$work/remote.err" | tr '\n' ' ')"
  exit 1
fi
