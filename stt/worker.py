#!/usr/bin/env python3
"""Bridge's transcriber: one process, one loaded whisper model, file paths in, JSON out.

Reads a path per line on stdin, writes {"text": ...} (or {"error": ...}) per line on stdout.
Prefers mlx_whisper (Apple-silicon GPU, large-v3-turbo) and falls back to openai-whisper on
the CPU. Fully offline — nothing leaves the machine.
"""
import json
import os
import sys
import time

REPO = os.environ.get("BRIDGE_STT_MLX_REPO", "mlx-community/whisper-large-v3-turbo")
CPU_MODEL = os.environ.get("BRIDGE_STT_MODEL", "base.en")

engine = None
model = None
t0 = time.time()
try:
    import mlx_whisper  # type: ignore
    engine = "mlx"
except Exception:
    try:
        import whisper  # type: ignore
        model = whisper.load_model(CPU_MODEL)
        engine = "whisper"
    except Exception as e:  # pragma: no cover
        print(json.dumps({"error": "no whisper available: %s" % e}), flush=True)
        sys.exit(1)


def run(path: str) -> str:
    if engine == "mlx":
        r = mlx_whisper.transcribe(path, path_or_hf_repo=REPO, language="en", fp16=True)
    else:
        r = model.transcribe(path, language="en", fp16=False)
    return (r.get("text") or "").strip()


if engine == "mlx":
    # first call pays for the model load; do it on a second of silence so the first real
    # utterance comes back fast
    try:
        import numpy as np  # type: ignore
        mlx_whisper.transcribe(np.zeros(16000, dtype=np.float32), path_or_hf_repo=REPO, language="en")
    except Exception:
        pass

print(json.dumps({"ready": True, "engine": engine, "ms": int((time.time() - t0) * 1000)}), flush=True)

for line in sys.stdin:
    p = line.strip()
    if not p:
        continue
    try:
        text = run(p)
        # whisper hallucinates on silence; the usual phantoms are dropped here
        if text.lower().strip(" .!") in ("you", "thank you", "thanks for watching", "bye", ""):
            text = ""
        print(json.dumps({"text": text}), flush=True)
    except Exception as e:
        print(json.dumps({"error": str(e)}), flush=True)
