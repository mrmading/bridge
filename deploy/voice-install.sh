#!/usr/bin/env bash
# Paquito's voice on a Linux box (the Fly sprite): Kokoro-82M through kokoro-onnx on the CPU, so
# /api/tts answers with real audio instead of the phone falling back to on-device speech.
#
#   python packages   kokoro-onnx (onnxruntime + a wheel-bundled espeak-ng) and soundfile,
#                     into the voice worker's venv (~/.local/whisper-venv, the one server.ts tries first)
#   model files       kokoro-v1.0.onnx + voices-v1.0.bin into ~/.local/share/kokoro, from a pinned
#                     Hugging Face revision, sha256-checked
#
# Idempotent: a second run checks and exits. Nothing is started; the worker loads Kokoro on first use.
# Run on the sprite:  deploy/sprite.sh does it (SKIP_VOICE=1 skips), or by hand:
#   sprite exec -o nestor-280 -s bridge -- bash -s < deploy/voice-install.sh
set -euo pipefail
VENV="${BRIDGE_VOICE_VENV:-$HOME/.local/whisper-venv}"
DIR="${BRIDGE_TTS_KOKORO_DIR:-$HOME/.local/share/kokoro}"
REV="8d07950c9b6c87ce6809e9bba7bd494336217c2a"   # huggingface.co/fastrtc/kokoro-onnx (same files as the kokoro-onnx v1.0 release)
BASE="https://huggingface.co/fastrtc/kokoro-onnx/resolve/$REV"
declare -A SHA=(
  [kokoro-v1.0.onnx]=7d5df8ecf7d4b1878015a32686053fd0eebe2bc377234608764cc0ef3636a6c5
  [voices-v1.0.bin]=bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d
)

if [[ "$(uname -s)" != Linux ]]; then echo "voice: not Linux, skipping (a Mac speaks through mlx_audio)"; exit 0; fi

# 1. the venv and the packages
if [[ ! -x "$VENV/bin/python" ]]; then
  echo "voice: creating $VENV"
  if command -v uv >/dev/null; then uv venv -q "$VENV"; else python3 -m venv "$VENV"; fi
fi
if "$VENV/bin/python" -c "import kokoro_onnx, soundfile" 2>/dev/null; then
  echo "voice: kokoro-onnx already installed"
else
  echo "voice: installing kokoro-onnx + soundfile"
  if command -v uv >/dev/null; then uv pip install -q --python "$VENV/bin/python" kokoro-onnx soundfile </dev/null
  else "$VENV/bin/python" -m pip install -q kokoro-onnx soundfile </dev/null; fi   # stdin is this script when piped
fi

# 2. the model files, downloaded beside themselves and moved into place only when the hash matches
mkdir -p "$DIR"
for f in "${!SHA[@]}"; do
  if [[ -s "$DIR/$f" ]] && [[ "$(sha256sum < "$DIR/$f" | cut -d' ' -f1)" == "${SHA[$f]}" ]]; then
    echo "voice: $f present"; continue
  fi
  echo "voice: downloading $f"
  curl -fsSL --retry 3 -o "$DIR/$f.part" "$BASE/$f"
  got="$(sha256sum < "$DIR/$f.part" | cut -d' ' -f1)"
  if [[ "$got" != "${SHA[$f]}" ]]; then rm -f "$DIR/$f.part"; echo "voice: $f checksum mismatch ($got)" >&2; exit 1; fi
  mv -f "$DIR/$f.part" "$DIR/$f"
done
echo "voice: ready ($DIR)"
