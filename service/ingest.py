"""Character-from-recording POC.

Pipeline: a downloaded recording/video → a Character with emotion-scaled Voices.

  1. INGEST   ffmpeg extracts audio.
  2. MAP      ElevenLabs Scribe → diarized words + timestamps → pick target speaker.
  3. ISOLATE  ElevenLabs Voice Isolator → clean studio track (timing preserved),
              then slice the target speaker's utterances from the clean track.
  4. LABEL    Gemini 3.5-flash classifies each segment into our emotion scale;
              low-confidence segments escalate to gemini-3.1-pro-preview.
  5. STEM     group segments by emotion → concatenate → one clean sample/emotion.
  6. CLONE    pocket-tts export-voice on each stem → the Character's emotion Voices
              (written into the same voices/ + _meta.json the web app reads).

Paid services (keys from env): ELEVEN_LABS_API_KEY, GEMINI_API_KEY.

  python -m service.ingest path/to/dialogue.mp3 --character "Nora" [--speaker auto]
      [--min-stem 4] [--limit 40] [--dry-run]
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import subprocess
import sys
import tempfile
import urllib.request
import uuid
import wave
from datetime import datetime, timezone
from pathlib import Path

from service.emotions import BASELINE, EMOTION_SCALE
from service.voices import VOICES_DIR, _load_meta, _save_meta, _slug  # reuse the store

ELEVEN_KEY = os.environ.get("ELEVEN_LABS_API_KEY", "")
GEMINI_KEY = os.environ.get("GEMINI_API_KEY", "")
FLASH_MODEL = os.environ.get("INGEST_FLASH_MODEL", "gemini-3.5-flash")
PRO_MODEL = os.environ.get("INGEST_PRO_MODEL", "gemini-3.1-pro-preview")

EMOTIONS = [e for e in EMOTION_SCALE]  # baseline + the rest


def log(msg: str) -> None:
    print(msg, flush=True)


# ── ffmpeg helpers ────────────────────────────────────────────────────────────
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
    """Concatenate 24k mono wavs (in order), capped. Returns duration."""
    frames: list[bytes] = []
    params = None
    total = 0.0
    for p in paths:
        with wave.open(str(p), "rb") as w:
            if params is None:
                params = w.getparams()
            fr = w.getframerate()
            dur = w.getnframes() / fr
            frames.append(w.readframes(w.getnframes()))
            total += dur
            if total >= cap_seconds:
                break
    with wave.open(str(dst), "wb") as w:
        w.setparams(params)  # type: ignore[arg-type]
        for f in frames:
            w.writeframes(f)
    return round(min(total, cap_seconds), 2)


# ── ElevenLabs ────────────────────────────────────────────────────────────────
def scribe(path: Path) -> dict:
    import mimetypes
    boundary = "----gvt" + uuid.uuid4().hex
    fields = {"model_id": "scribe_v1", "diarize": "true",
              "timestamps_granularity": "word", "tag_audio_events": "true"}
    body = b""
    for k, v in fields.items():
        body += f"--{boundary}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{v}\r\n".encode()
    ctype = mimetypes.guess_type(str(path))[0] or "audio/mpeg"
    body += (f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; "
             f"filename=\"{path.name}\"\r\nContent-Type: {ctype}\r\n\r\n").encode()
    body += path.read_bytes() + f"\r\n--{boundary}--\r\n".encode()
    req = urllib.request.Request(
        "https://api.elevenlabs.io/v1/speech-to-text", data=body,
        headers={"xi-api-key": ELEVEN_KEY, "Content-Type": f"multipart/form-data; boundary={boundary}"})
    with urllib.request.urlopen(req, timeout=300) as r:
        return json.load(r)


def voice_isolate(path: Path, dst_mp3: Path) -> None:
    boundary = "----gvt" + uuid.uuid4().hex
    body = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"audio\"; "
            f"filename=\"{path.name}\"\r\nContent-Type: audio/mpeg\r\n\r\n").encode()
    body += path.read_bytes() + f"\r\n--{boundary}--\r\n".encode()
    req = urllib.request.Request(
        "https://api.elevenlabs.io/v1/audio-isolation", data=body,
        headers={"xi-api-key": ELEVEN_KEY, "Content-Type": f"multipart/form-data; boundary={boundary}"})
    with urllib.request.urlopen(req, timeout=300) as r:
        dst_mp3.write_bytes(r.read())


# ── Gemini emotion labelling ──────────────────────────────────────────────────
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
    txt = out["candidates"][0]["content"]["parts"][0]["text"]
    d = json.loads(txt)
    emo = str(d.get("emotion", "")).lower().strip()
    if emo not in EMOTIONS:
        emo = BASELINE
    return {"emotion": emo, "confidence": float(d.get("confidence", 0)), "cue": d.get("cue", "")}


def label_emotion(wav: Path, escalate_below: float = 0.7) -> dict:
    res = _gemini(FLASH_MODEL, wav)
    res["model"] = FLASH_MODEL
    if res["confidence"] < escalate_below:
        try:
            pro = _gemini(PRO_MODEL, wav)
            pro["model"] = PRO_MODEL
            return pro
        except Exception:  # noqa: BLE001 - keep the flash result on escalation failure
            pass
    return res


# ── segmentation ──────────────────────────────────────────────────────────────
def build_segments(words: list[dict], min_gap: float = 0.6, min_dur: float = 1.2) -> list[dict]:
    """Merge consecutive same-speaker words into utterance segments."""
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


# ── clone a stem into a Voice ────────────────────────────────────────────────
def clone_stem(stem_wav: Path, character: str, emotion: str, seconds: float) -> str:
    cid = _slug(character)
    voice_id = f"{cid}-{emotion}-{uuid.uuid4().hex[:6]}"
    out = VOICES_DIR / f"{voice_id}.safetensors"
    VOICES_DIR.mkdir(parents=True, exist_ok=True)
    ex = subprocess.run([sys.executable, "-m", "pocket_tts", "export-voice", str(stem_wav), str(out)],
                        capture_output=True)
    if ex.returncode != 0 or not out.is_file():
        raise RuntimeError(f"clone failed: {ex.stderr.decode(errors='ignore')[-200:]}")
    meta = _load_meta()
    meta["voices"][voice_id] = {
        "name": character, "character_id": cid, "emotion": emotion,
        "created": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "sample_seconds": seconds, "lang": "EN", "source": "ingest",
    }
    meta["characters"].setdefault(cid, {"name": character, "tags": ["ingested"]})
    _save_meta(meta)
    return voice_id


# ── orchestrator ──────────────────────────────────────────────────────────────
def run(audio: Path, character: str, speaker: str, min_stem: float, limit: int, dry_run: bool) -> None:
    assert ELEVEN_KEY, "ELEVEN_LABS_API_KEY missing"
    assert GEMINI_KEY, "GEMINI_API_KEY missing"

    with tempfile.TemporaryDirectory(prefix="gvt-ingest-") as td:
        tmp = Path(td)

        log("[1/6] transcribe + diarize (Scribe)…")
        tr = scribe(audio)
        words = tr.get("words", [])
        dur = tr.get("audio_duration_secs", 0)
        segs_all = build_segments(words)
        speakers = sorted({s["speaker"] for s in segs_all})
        target = pick_speaker(segs_all) if speaker == "auto" else speaker
        segs = [s for s in segs_all if s["speaker"] == target]
        log(f"      {dur}s · speakers={speakers} · target={target} · {len(segs)} utterances")

        log("[2/6] isolate voice (Voice Isolator)…")
        iso_mp3 = tmp / "iso.mp3"
        voice_isolate(audio, iso_mp3)
        clean = tmp / "clean.wav"
        to_wav(iso_mp3, clean)

        log(f"[3/6] slice + label emotions (flash→pro escalation, cap {limit})…")
        labelled: list[dict] = []
        for i, s in enumerate(segs[:limit]):
            seg_wav = tmp / f"seg_{i:03d}.wav"
            to_wav(clean, seg_wav, s["start"], s["end"])
            lab = label_emotion(seg_wav)
            lab.update({"i": i, "start": s["start"], "end": s["end"], "wav": seg_wav,
                        "dur": round(s["end"] - s["start"], 2), "text": s["text"][:48]})
            labelled.append(lab)
            log(f"      seg {i:02d} [{lab['dur']:>4}s] {lab['emotion']:9} "
                f"{lab['confidence']:.2f} ({lab['model'].split('-')[1]}) — {lab['cue']}")

        log("[4/6] group into emotion stems…")
        by_emotion: dict[str, list[dict]] = {}
        for lab in labelled:
            by_emotion.setdefault(lab["emotion"], []).append(lab)
        # always ensure a baseline stem from the whole target track
        stems: dict[str, tuple[Path, float]] = {}
        base_wav = tmp / "stem_baseline.wav"
        base_dur = concat_wavs([lab["wav"] for lab in labelled], base_wav)
        stems[BASELINE] = (base_wav, base_dur)
        for emo, labs in by_emotion.items():
            if emo == BASELINE:
                continue
            total = sum(l["dur"] for l in labs)
            if total < min_stem:
                log(f"      skip {emo}: only {total:.1f}s (< {min_stem}s)")
                continue
            sw = tmp / f"stem_{emo}.wav"
            d = concat_wavs([l["wav"] for l in labs], sw)
            stems[emo] = (sw, d)
        log("      stems: " + ", ".join(f"{e}={d}s" for e, (_, d) in stems.items()))

        if dry_run:
            log("[6/6] dry-run — skipping clone.")
            return

        log("[5/6] clone each stem → Character Voices (pocket-tts)…")
        created = []
        for emo, (sw, d) in stems.items():
            vid = clone_stem(sw, character, emo, d)
            created.append((emo, vid))
            log(f"      cloned {emo:9} → {vid}")

        log(f"[6/6] DONE — Character '{character}' ({_slug(character)}) has "
            f"{len(created)} emotion voices: {', '.join(e for e, _ in created)}")
        log("      Open the web app → Voices → this Character to review/play.")


def main() -> None:
    try:  # Windows consoles default to cp1252; our logs use → · …
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
    run(Path(a.audio), a.character, a.speaker, a.min_stem, a.limit, a.dry_run)


if __name__ == "__main__":
    main()
