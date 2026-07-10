"""Character-from-recording pipeline (scan → review → commit).

  1. INGEST   ffmpeg extracts audio.
  2. MAP      ElevenLabs Scribe → diarized words + timestamps → pick target speaker.
  3. ISOLATE  ElevenLabs Voice Isolator → clean studio track (timing preserved).
  4. LABEL    Gemini 3.5-flash classifies each segment into our emotion scale;
              low-confidence segments escalate to gemini-3.1-pro-preview.
  5. STEM     group segments by emotion → concatenate → one clean sample/emotion.
  --- user reviews the proposed stems here (assign / descope / extend) ---
  6. COMMIT   pocket-tts export-voice on each accepted stem → the Character's
              emotion Voices (into the shared voices/ + _meta.json store).

`scan()` does 1-5 (no cloning) and leaves the stem wavs in a work dir; `commit()`
clones the chosen stems. Keys from env: ELEVEN_LABS_API_KEY, GEMINI_API_KEY.
CLI (one-shot): python -m service.ingest <audio> --character NAME [--dry-run]
"""
from __future__ import annotations

import argparse
import base64
import json
import mimetypes
import os
import subprocess
import sys
import uuid
import wave
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

from service.emotions import BASELINE, EMOTION_SCALE
from service.voices import VOICES_DIR, _load_meta, _save_meta, _slug

ELEVEN_KEY = os.environ.get("ELEVEN_LABS_API_KEY", "")
GEMINI_KEY = os.environ.get("GEMINI_API_KEY", "")
FLASH_MODEL = os.environ.get("INGEST_FLASH_MODEL", "gemini-3.5-flash")
PRO_MODEL = os.environ.get("INGEST_PRO_MODEL", "gemini-3.1-pro-preview")
EMOTIONS = list(EMOTION_SCALE)

import urllib.request  # noqa: E402


def _log(m: str) -> None:
    print(m, flush=True)


# ── ffmpeg ────────────────────────────────────────────────────────────────────
def to_wav(src: Path, dst: Path, start: float | None = None, end: float | None = None) -> None:
    cmd = ["ffmpeg", "-y", "-i", str(src)]
    if start is not None:
        cmd += ["-ss", f"{start:.3f}"]
    if end is not None:
        cmd += ["-to", f"{end:.3f}"]
    cmd += ["-ac", "1", "-ar", "24000", str(dst)]
    r = subprocess.run(cmd, capture_output=True)
    if r.returncode != 0:
        raise RuntimeError(f"ffmpeg failed: {r.stderr.decode(errors='ignore')[-200:]}")


def concat_wavs(paths: list[Path], dst: Path, cap_seconds: float = 30.0) -> float:
    frames: list[bytes] = []
    params = None
    total = 0.0
    for p in paths:
        with wave.open(str(p), "rb") as w:
            if params is None:
                params = w.getparams()
            total += w.getnframes() / w.getframerate()
            frames.append(w.readframes(w.getnframes()))
            if total >= cap_seconds:
                break
    with wave.open(str(dst), "wb") as w:
        w.setparams(params)  # type: ignore[arg-type]
        for f in frames:
            w.writeframes(f)
    return round(min(total, cap_seconds), 2)


# ── ElevenLabs ────────────────────────────────────────────────────────────────
def _multipart(fields: dict[str, str], file_field: str, path: Path) -> tuple[bytes, str]:
    boundary = "----gvt" + uuid.uuid4().hex
    body = b""
    for k, v in fields.items():
        body += f"--{boundary}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{v}\r\n".encode()
    ctype = mimetypes.guess_type(str(path))[0] or "audio/mpeg"
    body += (f"--{boundary}\r\nContent-Disposition: form-data; name=\"{file_field}\"; "
             f"filename=\"{path.name}\"\r\nContent-Type: {ctype}\r\n\r\n").encode()
    body += path.read_bytes() + f"\r\n--{boundary}--\r\n".encode()
    return body, boundary


def scribe(path: Path) -> dict:
    body, boundary = _multipart(
        {"model_id": "scribe_v1", "diarize": "true", "timestamps_granularity": "word",
         "tag_audio_events": "true"}, "file", path)
    req = urllib.request.Request(
        "https://api.elevenlabs.io/v1/speech-to-text", data=body,
        headers={"xi-api-key": ELEVEN_KEY, "Content-Type": f"multipart/form-data; boundary={boundary}"})
    with urllib.request.urlopen(req, timeout=300) as r:
        return json.load(r)


def voice_isolate(path: Path, dst_mp3: Path) -> None:
    body, boundary = _multipart({}, "audio", path)
    req = urllib.request.Request(
        "https://api.elevenlabs.io/v1/audio-isolation", data=body,
        headers={"xi-api-key": ELEVEN_KEY, "Content-Type": f"multipart/form-data; boundary={boundary}"})
    with urllib.request.urlopen(req, timeout=300) as r:
        dst_mp3.write_bytes(r.read())


# ── Gemini emotion ────────────────────────────────────────────────────────────
def _gemini(model: str, wav: Path) -> dict:
    audio = base64.b64encode(wav.read_bytes()).decode()
    prompt = (
        "Listen to the audio. Classify the speaker's EMOTIONAL DELIVERY (vocal tone/prosody, "
        f"not the words) into EXACTLY one of: {', '.join(EMOTIONS)}. "
        "Reply ONLY as compact JSON: {\"emotion\":\"...\",\"confidence\":0-1,\"cue\":\"<=8 words\"}.")
    body = json.dumps({
        "contents": [{"parts": [{"text": prompt}, {"inline_data": {"mime_type": "audio/wav", "data": audio}}]}],
        "generationConfig": {"responseMimeType": "application/json", "temperature": 0},
    }).encode()
    req = urllib.request.Request(
        f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={GEMINI_KEY}",
        data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as r:
        out = json.load(r)
    d = json.loads(out["candidates"][0]["content"]["parts"][0]["text"])
    emo = str(d.get("emotion", "")).lower().strip()
    return {"emotion": emo if emo in EMOTIONS else BASELINE,
            "confidence": float(d.get("confidence", 0)), "cue": d.get("cue", "")}


def label_emotion(wav: Path, escalate_below: float = 0.7) -> dict:
    res = _gemini(FLASH_MODEL, wav)
    res["model"] = FLASH_MODEL
    if res["confidence"] < escalate_below:
        try:
            pro = _gemini(PRO_MODEL, wav)
            pro["model"] = PRO_MODEL
            return pro
        except Exception:  # noqa: BLE001
            pass
    return res


# ── segmentation ──────────────────────────────────────────────────────────────
def build_segments(words: list[dict], min_gap: float = 0.6, min_dur: float = 1.2) -> list[dict]:
    segs: list[dict] = []
    cur = None
    for w in words:
        if w.get("type") != "word":
            continue
        spk = w.get("speaker_id", "speaker_0")
        st, en = float(w["start"]), float(w["end"])
        if cur and cur["speaker"] == spk and st - cur["end"] <= min_gap:
            cur["end"] = en
            cur["text"] += " " + w["text"]
        else:
            if cur and cur["end"] - cur["start"] >= min_dur:
                segs.append(cur)
            cur = {"speaker": spk, "start": st, "end": en, "text": w["text"]}
    if cur and cur["end"] - cur["start"] >= min_dur:
        segs.append(cur)
    return segs


def pick_speaker(segs: list[dict]) -> str:
    totals: dict[str, float] = {}
    for s in segs:
        totals[s["speaker"]] = totals.get(s["speaker"], 0) + (s["end"] - s["start"])
    return max(totals, key=totals.get) if totals else "speaker_0"


# ── SCAN (analysis only) ──────────────────────────────────────────────────────
def scan(audio: Path, work_dir: Path, speaker: str = "auto", min_stem: float = 4.0,
         limit: int = 40, progress: Callable[[str, str], None] | None = None) -> dict:
    """Run steps 1-5. Saves stem_<emotion>.wav into work_dir. Returns a review dict.
    `progress(step_key, state)` is called with state in {active, done}."""
    assert ELEVEN_KEY and GEMINI_KEY, "ELEVEN_LABS_API_KEY / GEMINI_API_KEY missing"
    work_dir.mkdir(parents=True, exist_ok=True)

    def prog(k: str, s: str) -> None:
        if progress:
            progress(k, s)

    prog("transcribe", "active")
    tr = scribe(audio)
    words = tr.get("words", [])
    duration = tr.get("audio_duration_secs", 0)
    all_segs = build_segments(words)
    speakers = sorted({s["speaker"] for s in all_segs})
    target = pick_speaker(all_segs) if speaker == "auto" else speaker
    tsegs = [s for s in all_segs if s["speaker"] == target]
    prog("transcribe", "done")

    prog("isolate", "active")
    iso = work_dir / "iso.mp3"
    voice_isolate(audio, iso)
    clean = work_dir / "clean.wav"
    to_wav(iso, clean)
    prog("isolate", "done")

    prog("label", "active")
    labelled: list[dict] = []
    for i, s in enumerate(tsegs[:limit]):
        seg_wav = work_dir / f"seg_{i:03d}.wav"
        to_wav(clean, seg_wav, s["start"], s["end"])
        lab = label_emotion(seg_wav)
        lab.update({"i": i, "dur": round(s["end"] - s["start"], 2), "text": s["text"][:60], "wav": str(seg_wav)})
        labelled.append(lab)
    prog("label", "done")

    prog("stem", "active")
    by_emotion: dict[str, list[dict]] = {}
    for lab in labelled:
        by_emotion.setdefault(lab["emotion"], []).append(lab)
    stems: list[dict] = []
    # baseline always available from the whole target track
    base_wav = work_dir / "stem_baseline.wav"
    base_dur = concat_wavs([Path(l["wav"]) for l in labelled], base_wav)
    stems.append({"emotion": BASELINE, "seconds": base_dur, "segments": len(labelled),
                  "eligible": base_dur >= min_stem, "cues": []})
    for emo, labs in by_emotion.items():
        if emo == BASELINE:
            continue
        total = round(sum(l["dur"] for l in labs), 2)
        sw = work_dir / f"stem_{emo}.wav"
        d = concat_wavs([Path(l["wav"]) for l in labs], sw)
        stems.append({"emotion": emo, "seconds": d, "segments": len(labs),
                      "eligible": total >= min_stem, "cues": [l["cue"] for l in labs[:3]]})
    order = {e: i for i, e in enumerate(EMOTION_SCALE)}
    stems.sort(key=lambda s: order.get(s["emotion"], 99))
    prog("stem", "done")

    return {"duration": duration, "speakers": speakers, "target": target,
            "utterances": len(tsegs), "min_stem": min_stem, "stems": stems,
            "segments": [{"emotion": l["emotion"], "confidence": l["confidence"],
                          "cue": l["cue"], "dur": l["dur"], "text": l["text"],
                          "model": l["model"]} for l in labelled]}


# ── COMMIT (clone selected stems) ─────────────────────────────────────────────
def commit(work_dir: Path, character: str, emotions: list[str], existing_cid: str | None = None) -> list[dict]:
    cid = existing_cid or _slug(character)
    meta = _load_meta()
    name = meta["characters"].get(cid, {}).get("name", character) if existing_cid else character
    created: list[dict] = []
    for emo in emotions:
        sw = work_dir / f"stem_{emo}.wav"
        if not sw.is_file():
            continue
        with wave.open(str(sw), "rb") as w:
            seconds = round(w.getnframes() / w.getframerate(), 2)
        voice_id = f"{cid}-{emo}-{uuid.uuid4().hex[:6]}"
        out = VOICES_DIR / f"{voice_id}.safetensors"
        VOICES_DIR.mkdir(parents=True, exist_ok=True)
        ex = subprocess.run([sys.executable, "-m", "pocket_tts", "export-voice", str(sw), str(out)],
                            capture_output=True)
        if ex.returncode != 0 or not out.is_file():
            raise RuntimeError(f"clone {emo} failed: {ex.stderr.decode(errors='ignore')[-200:]}")
        meta = _load_meta()
        meta["voices"][voice_id] = {
            "name": name, "character_id": cid, "emotion": emo,
            "created": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "sample_seconds": seconds, "lang": "EN", "source": "ingest"}
        meta["characters"].setdefault(cid, {"name": name, "tags": ["ingested"]})
        _save_meta(meta)
        created.append({"voice_id": voice_id, "emotion": emo, "seconds": seconds})
    return created


# ── CLI (one-shot) ────────────────────────────────────────────────────────────
def main() -> None:
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
    except Exception:  # noqa: BLE001
        pass
    ap = argparse.ArgumentParser()
    ap.add_argument("audio")
    ap.add_argument("--character", required=True)
    ap.add_argument("--speaker", default="auto")
    ap.add_argument("--min-stem", type=float, default=4.0)
    ap.add_argument("--limit", type=int, default=40)
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    import tempfile
    with tempfile.TemporaryDirectory(prefix="gvt-ingest-") as td:
        wd = Path(td)
        res = scan(Path(a.audio), wd, a.speaker, a.min_stem, a.limit,
                   progress=lambda k, s: _log(f"  {k}: {s}"))
        _log(json.dumps({k: v for k, v in res.items() if k != "segments"}, indent=2))
        if a.dry_run:
            return
        elig = [s["emotion"] for s in res["stems"] if s["eligible"]]
        created = commit(wd, a.character, elig)
        _log(f"created: {created}")


if __name__ == "__main__":
    main()
