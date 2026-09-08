#!/usr/bin/env python3
"""Bridge's voice worker: one process, the models loaded once, JSON requests in, JSON out.

Every stdin line is a request: {"id": "...", "op": "stt", "path": "/x.wav"} or
{"id": "...", "op": "tts", "text": "...", "out": "/x.wav", "speed": 1.1}. Every stdout line
is a reply carrying the same id: {"id", "text"} for stt, {"id", "out", "seconds"} for tts, or
{"id", "error"}. The first line is {"ready": true, "stt": <engine>, "tts": <engine>, "ms": N}.

Listening prefers NVIDIA Parakeet TDT 0.6B v3 on MLX (streaming transducer, ~1.9% WER on
clean English, ~300 ms per utterance on an M2), then mlx_whisper large-v3-turbo, then
openai-whisper on the CPU. Speaking uses Kokoro-82M on MLX when mlx_audio is installed.
Fully offline: nothing leaves the machine.
"""
import json
import os
import sys
import time

STT_ENGINE = os.environ.get("BRIDGE_STT_ENGINE", "auto")           # auto | parakeet | mlx | whisper
PARAKEET_REPO = os.environ.get("BRIDGE_STT_PARAKEET_REPO", "mlx-community/parakeet-tdt-0.6b-v3")
WHISPER_REPO = os.environ.get("BRIDGE_STT_MLX_REPO", "mlx-community/whisper-large-v3-turbo")
CPU_MODEL = os.environ.get("BRIDGE_STT_MODEL", "base.en")
TTS_ENGINE = os.environ.get("BRIDGE_TTS_ENGINE", "auto")           # auto | kokoro | none
KOKORO_REPO = os.environ.get("BRIDGE_TTS_KOKORO_REPO", "mlx-community/Kokoro-82M-bf16")
KOKORO_VOICE = os.environ.get("BRIDGE_TTS_VOICE", "af_heart")
KOKORO_LANG = os.environ.get("BRIDGE_TTS_LANG", "a")               # 'a' American, 'b' British

# whisper hallucinates on silence; parakeet mostly returns nothing, but the same phantoms are
# dropped for both so a quiet clip never sends "Thank you." to the assistant
PHANTOMS = ("you", "thank you", "thanks for watching", "bye", "")


def out(obj: dict) -> None:
    print(json.dumps(obj), flush=True)


def warn(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


# ───────────────────────── listening ─────────────────────────
stt_engine = None
stt_model = None
t0 = time.time()

if STT_ENGINE in ("auto", "parakeet"):
    try:
        from parakeet_mlx import from_pretrained  # type: ignore
        stt_model = from_pretrained(PARAKEET_REPO)
        stt_engine = "parakeet"
    except Exception as e:
        if STT_ENGINE == "parakeet":
            out({"error": "parakeet unavailable: %s" % e})
            sys.exit(1)
        warn("parakeet unavailable, falling back: %s" % e)

if stt_engine is None and STT_ENGINE in ("auto", "mlx"):
    try:
        import mlx_whisper  # type: ignore
        stt_engine = "mlx"
    except Exception as e:
        if STT_ENGINE == "mlx":
            out({"error": "mlx_whisper unavailable: %s" % e})
            sys.exit(1)
        warn("mlx_whisper unavailable, falling back: %s" % e)

if stt_engine is None:
    try:
        import whisper  # type: ignore
        stt_model = whisper.load_model(CPU_MODEL)
        stt_engine = "whisper"
    except Exception as e:
        out({"error": "no transcriber available: %s" % e})
        sys.exit(1)


def transcribe(path: str) -> str:
    if stt_engine == "parakeet":
        text = stt_model.transcribe(path).text
    elif stt_engine == "mlx":
        text = mlx_whisper.transcribe(path, path_or_hf_repo=WHISPER_REPO, language="en", fp16=True).get("text")
    else:
        text = stt_model.transcribe(path, language="en", fp16=False).get("text")
    text = (text or "").strip()
    return "" if text.lower().strip(" .!") in PHANTOMS else text


# the first call pays for graph compilation; spend it on a second of silence so the first real
# utterance comes back fast
try:
    import numpy as np  # type: ignore
    if stt_engine == "parakeet":
        import soundfile as sf  # type: ignore
        warm = "/tmp/bridge-stt-warm.wav"
        sf.write(warm, np.zeros(16000, dtype=np.float32), 16000)
        stt_model.transcribe(warm)
        os.unlink(warm)
    elif stt_engine == "mlx":
        mlx_whisper.transcribe(np.zeros(16000, dtype=np.float32), path_or_hf_repo=WHISPER_REPO, language="en")
except Exception as e:
    warn("stt warm-up skipped: %s" % e)

# ───────────────────────── speaking ─────────────────────────
tts_engine = "none"
tts_model = None
if TTS_ENGINE in ("auto", "kokoro"):
    try:
        from mlx_audio.tts.utils import load_model  # type: ignore
        tts_model = load_model(KOKORO_REPO)
        # load_model does not touch the G2P pipeline; one short line does, and surfaces a missing
        # misaki install here instead of on the first real sentence
        list(tts_model.generate(text="Ready.", voice=KOKORO_VOICE, speed=1.0, lang_code=KOKORO_LANG))
        tts_engine = "kokoro"
    except Exception as e:
        if TTS_ENGINE == "kokoro":
            out({"error": "kokoro unavailable: %s" % e})
            sys.exit(1)
        warn("kokoro unavailable, speaking falls back to the server's other voices: %s" % e)


def synthesize(text: str, path: str, speed: float) -> float:
    import numpy as np  # type: ignore
    import soundfile as sf  # type: ignore
    chunks = list(tts_model.generate(text=text, voice=KOKORO_VOICE, speed=speed, lang_code=KOKORO_LANG))
    if not chunks:
        raise RuntimeError("kokoro produced no audio")
    rate = int(getattr(chunks[0], "sample_rate", 24000) or 24000)
    audio = np.concatenate([np.asarray(c.audio, dtype=np.float32) for c in chunks])
    sf.write(path, audio, rate)
    return round(len(audio) / rate, 2)


out({"ready": True, "stt": stt_engine, "tts": tts_engine, "ms": int((time.time() - t0) * 1000)})

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        req = json.loads(line)
    except Exception:
        # the pre-0.1.6 protocol was a bare path per line; keep answering it, without an id
        req = {"op": "stt", "path": line}
    rid = req.get("id")
    started = time.time()
    try:
        op = req.get("op", "stt")
        if op == "stt":
            path = req.get("path") or ""
            if not os.path.exists(path):
                raise FileNotFoundError(path)
            out({"id": rid, "text": transcribe(path), "ms": int((time.time() - started) * 1000)})
        elif op == "tts":
            if tts_engine == "none":
                raise RuntimeError("no local voice: install mlx_audio and misaki[en]")
            text = str(req.get("text") or "").strip()
            path = req.get("out") or ""
            if not text or not path:
                raise ValueError("tts needs text and out")
            speed = float(req.get("speed") or 1.0)
            speed = min(2.0, max(0.5, speed))
            seconds = synthesize(text, path, speed)
            out({"id": rid, "out": path, "seconds": seconds, "ms": int((time.time() - started) * 1000)})
        else:
            raise ValueError("unknown op: %s" % op)
    except Exception as e:
        out({"id": rid, "error": str(e)})
