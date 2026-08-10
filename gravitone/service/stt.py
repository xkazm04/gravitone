"""Local speech-to-text — the ear this service never had.

Gravitone could always speak. Listening was the half it bought: the cloud
ingest path pays ElevenLabs Scribe to turn a recording into diarized words
(service/ingest.py), and sovereign mode answers the same question by declining
to ask it — "no transcript — speech is found by level, not by words, so nothing
is transcribed and no text ever leaves this machine". That was an honest
limitation, not a good one. faster-whisper (CTranslate2, int8, CPU) removes it
without giving the sovereign claim back: weights live on disk, inference runs
on the same cores as the TTS pool, and nothing is uploaded.

Two callers, two different asks:

* ``POST /v1/speech-to-text`` — a whole recording, shaped like the ElevenLabs
  Scribe response so client code (and, later, ingest's CLOUD path) can repoint
  at localhost. Word timestamps on, accuracy over latency.
* the conversation session (service/convai.py) — one utterance, mid-turn, with
  a person waiting. No word timestamps, greedy decode, and the answer is worth
  less the longer it takes.

**Diarization lives in service/diarize.py** and is opt-in per request
(``diarize=true``). Read that module's warning before believing a speaker count:
where speech starts and stops is dependable, WHO is speaking across a gap is
not. Without it every word comes back ``speaker_0`` — which is the same
admission sovereign ingest makes, not a claim that one speaker was detected.

**One transcription at a time per process.** The CTranslate2 generator is not
safe to drive concurrently from several threads, and on a box whose core budget
is already pinned to the TTS workers, parallel decodes would trade latency for
latency anyway. The lock is the honest ceiling; scale by replica, exactly as
``config.Settings.workers`` argues for synthesis.

**Partial decodes never delay a real one.** ``transcribe_partial`` exists so a
conversation can hear the utterance-so-far while it is still being spoken
(service/convai.py, CONVAI_PARTIAL_DECODE). It shares the one run lock with
every other decode, so it is strictly subordinate to it: it takes the lock only
if it is free, it declines outright while a FINAL decode is waiting for it, and
it never loads the model — a partial is worth nothing if paying for it makes the
turn that matters slower. Dropping a partial costs nothing; delaying the final
costs the caller.
"""
from __future__ import annotations

import io
import logging
import threading
import time
from dataclasses import dataclass, field
from typing import Any

import numpy as np
from fastapi import APIRouter, File, Form, HTTPException, UploadFile

from service.config import SETTINGS

logger = logging.getLogger("gravitone.stt")

router = APIRouter(tags=["speech-to-text"])

# Whisper's native rate. Everything is resampled to this before it reaches the
# model, so it is also the rate the conversation protocol speaks (see
# Settings.convai_audio_rate).
TARGET_RATE = 16000

# Ceiling on an upload, checked before anything is decoded. Duration is the
# limit that matters (Settings.stt_max_clip_seconds) but it cannot be known
# until the file is decoded, and decoding an arbitrary-sized upload is itself
# the attack. Same 50 MB the ingest upload accepts.
MAX_UPLOAD_BYTES = 50 * 1024 * 1024

_MODEL: Any = None
_MODEL_KEY: tuple | None = None      # the settings the loaded model was built from
_LOAD_LOCK = threading.Lock()        # guards loading
_RUN_LOCK = threading.Lock()         # guards transcription (see module docstring)
# How many FINAL conversational decodes are queued for _RUN_LOCK right now. Only
# the partial path reads it, and only to get out of the way.
_FINALS_WAITING = 0
_WAITING_LOCK = threading.Lock()
# Partial-decode accounting, for the latency reporting a conversation publishes.
_PARTIALS = {"run": 0, "dropped_busy": 0, "dropped_for_final": 0, "dropped_cold": 0}

_INSTALL_HINT = (
    "local speech-to-text needs faster-whisper, which is not installed in this "
    "environment. Install it with `pip install -r requirements.txt` (or "
    "`pip install faster-whisper`) and restart the service."
)


@dataclass
class Word:
    text: str
    start: float
    end: float
    speaker_id: str = "speaker_0"
    # faster-whisper's per-word probability, when the backend rates words at
    # all. None = unrated — verify.py's confidence floor treats that honestly
    # (confidence_source: "unrated") instead of scoring against a guess.
    confidence: float | None = None


@dataclass
class Transcript:
    text: str
    language_code: str
    language_probability: float
    duration_s: float
    transcribe_s: float
    words: list[Word] = field(default_factory=list)

    def realtime_factor(self) -> float | None:
        """Audio seconds per second of compute. >1 is faster than real time."""
        if self.transcribe_s <= 0:
            return None
        return round(self.duration_s / self.transcribe_s, 3)


class SttUnavailable(RuntimeError):
    """faster-whisper is missing, or its weights could not be loaded.

    Authored for the caller: the message says what to install. Routes turn it
    into a 503 (the capability is absent, the request was not wrong).
    """


def _model_key() -> tuple:
    return (SETTINGS.stt_model, SETTINGS.stt_device, SETTINGS.stt_compute_type,
            SETTINGS.stt_threads, SETTINGS.stt_download_root)


def load_model():
    """The process's Whisper model, loaded on first use and kept hot.

    Blocking and slow the first time (weights download, then load), which is
    why every caller either runs on the threadpool or offloads. Reloads itself
    if the settings it was built from changed — the tests swap SETTINGS.
    """
    global _MODEL, _MODEL_KEY
    key = _model_key()
    if _MODEL is not None and _MODEL_KEY == key:
        return _MODEL
    with _LOAD_LOCK:
        if _MODEL is not None and _MODEL_KEY == key:
            return _MODEL
        try:
            from faster_whisper import WhisperModel
        except ImportError as exc:
            raise SttUnavailable(_INSTALL_HINT) from exc
        t0 = time.perf_counter()
        kwargs: dict = {"device": SETTINGS.stt_device,
                        "compute_type": SETTINGS.stt_compute_type,
                        "cpu_threads": SETTINGS.stt_threads}
        if SETTINGS.stt_download_root:
            kwargs["download_root"] = SETTINGS.stt_download_root
        try:
            model = WhisperModel(SETTINGS.stt_model, **kwargs)
        except Exception as exc:  # noqa: BLE001 - a load failure must SAY so
            raise SttUnavailable(
                f"could not load the speech-to-text model '{SETTINGS.stt_model}' "
                f"({type(exc).__name__}: {exc}). Check STT_MODEL and that this box "
                "can reach the model cache."
            ) from exc
        logger.info("stt model '%s' loaded in %.1fs (%s, %s)", SETTINGS.stt_model,
                    time.perf_counter() - t0, SETTINGS.stt_device,
                    SETTINGS.stt_compute_type)
        _MODEL, _MODEL_KEY = model, key
        return _MODEL


def available() -> bool:
    """Whether a transcription would work right now, without doing one.

    Cheap when the model is already up; the first call pays the load.
    """
    try:
        load_model()
        return True
    except SttUnavailable:
        return False


def describe_model() -> dict:
    """WHICH transcriber ran — the provenance a recording keeps.

    Deliberately excludes runtime state. A recording that says ``loaded:
    false`` because the model happened to still be warming when the call opened
    is worse than saying nothing: it is a fact about an instant, filed as if it
    described the run.
    """
    return {"model": SETTINGS.stt_model, "device": SETTINGS.stt_device,
            "compute_type": SETTINGS.stt_compute_type,
            "beam_size": SETTINGS.stt_beam_size, "diarization": False}


def info() -> dict:
    """What this replica's ear is and whether it is up, for /health-style
    reporting — where the live state is exactly the point."""
    return dict(describe_model(), loaded=_MODEL is not None,
                partials=partial_stats())


def pcm16_to_float32(pcm: bytes) -> np.ndarray:
    """Wire audio (PCM16 mono) to what the model wants (float32 in [-1, 1])."""
    return np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0


def transcribe(audio: "np.ndarray | io.BytesIO | str", *,
               language: str | None = None, hotwords: str | None = None,
               word_timestamps: bool = False,
               beam_size: int | None = None) -> Transcript:
    """Transcribe one clip. Blocking — call it on a thread, never on the loop.

    ``hotwords`` biases decoding toward words the model would otherwise mangle.
    This is the local answer to the failure the ElevenLabs agent needed a
    keyword list to survive — "React" heard as "Rust", "PostgreSQL" as "později
    SQL" — except that here the list can be per-request, which the browser SDK
    could not do at all.

    ``language`` pins the language instead of letting the model detect it. Pin
    it when you know: detection costs an extra pass and can flip mid-conversation
    on a short utterance, which is how a Czech interview acquires an English
    sentence.
    """
    model = load_model()
    t0 = time.perf_counter()
    with _RUN_LOCK:
        collected, detected = _decode(model, audio, language=language,
                                      hotwords=hotwords,
                                      word_timestamps=word_timestamps,
                                      beam_size=beam_size)
    return _assemble(collected, detected, time.perf_counter() - t0)


def _decode(model, audio, *, language: str | None, hotwords: str | None,
            word_timestamps: bool, beam_size: int | None):
    """The model call itself. Caller MUST hold ``_RUN_LOCK``."""
    segments, detected = model.transcribe(
        audio,
        language=language or None,
        beam_size=beam_size if beam_size is not None else SETTINGS.stt_beam_size,
        word_timestamps=word_timestamps,
        hotwords=hotwords or None,
        # Whisper's known failure mode on silence is to hallucinate a
        # sentence (a caption, a "thank you"). Both filters below make it
        # return nothing instead, which is what an empty room actually said.
        vad_filter=True,
        condition_on_previous_text=False,
    )
    # `segments` is a generator — the work happens HERE, inside the lock.
    return list(segments), detected


def _assemble(collected, detected, elapsed: float) -> Transcript:
    words: list[Word] = []
    parts: list[str] = []
    for seg in collected:
        parts.append(seg.text)
        for w in (getattr(seg, "words", None) or []):
            prob = getattr(w, "probability", None)
            words.append(Word(text=w.word.strip(), start=round(w.start, 3),
                              end=round(w.end, 3),
                              confidence=None if prob is None else round(float(prob), 3)))
    duration = float(getattr(detected, "duration", 0.0) or 0.0)
    return Transcript(
        text=" ".join(p.strip() for p in parts).strip(),
        language_code=str(getattr(detected, "language", "") or ""),
        language_probability=round(float(getattr(detected, "language_probability", 0.0) or 0.0), 3),
        duration_s=round(duration, 3),
        transcribe_s=round(elapsed, 3),
        words=words,
    )


def transcribe_pcm(pcm: bytes, *, rate: int = TARGET_RATE,
                   language: str | None = None, hotwords: str | None = None,
                   word_timestamps: bool = False) -> Transcript:
    """Transcribe raw PCM16 mono — the conversation path.

    No re-encode: the caller already has the samples. Word timestamps are OFF
    by default because a turn is waiting on this one and it has no use for
    them; ``word_timestamps=True`` is for the callers that do (verification —
    they are also the only way to get a per-word probability out of the model,
    so they buy the confidence floor as well as the timing). Measured cost on a
    16 s clip, small/int8/CPU: ~5% at beam 5, inside the noise at beam 1. There
    is no second decode — the alignment runs off the encoder output already
    computed.
    """
    audio = pcm16_to_float32(_at_target_rate(pcm, rate))
    global _FINALS_WAITING
    with _WAITING_LOCK:
        _FINALS_WAITING += 1
    try:
        return transcribe(audio, language=language, hotwords=hotwords,
                          word_timestamps=word_timestamps)
    finally:
        with _WAITING_LOCK:
            _FINALS_WAITING -= 1


def _at_target_rate(pcm: bytes, rate: int) -> bytes:
    if rate == TARGET_RATE:
        return pcm
    from service.engine import resample_pcm16
    return resample_pcm16(np.frombuffer(pcm, dtype="<i2"), rate,
                          TARGET_RATE).tobytes()


def final_is_waiting() -> bool:
    """Whether a final conversational decode is queued behind the run lock.

    The one thing a speculative decode has to know: it is never allowed to be
    the reason a turn the caller is actually waiting for starts late.
    """
    return _FINALS_WAITING > 0


def partial_stats() -> dict:
    """Partial decodes run and, by reason, declined. Copied, not shared."""
    return dict(_PARTIALS)


def transcribe_partial(pcm: bytes, *, rate: int = TARGET_RATE,
                       language: str | None = None,
                       hotwords: str | None = None) -> Transcript | None:
    """Transcribe an utterance still in progress, or return None having done nothing.

    Speculative by construction, and subordinate to every real decode (see the
    module docstring). ``None`` means "not this time" and is the expected answer
    on a busy box — it is never an error, and there is nothing to retry:

      * the model is not loaded yet (a partial must not pay a ~2 s load),
      * a final decode is waiting for the run lock,
      * the run lock is held by someone else,
      * the clip is empty.

    The text that comes back is NOISIER than a final transcript
    (``condition_on_previous_text=False`` plus Whisper's silence behaviour on a
    clip that stops mid-word), which is why the caller must treat it as a hint
    and never as a record. It is greedy (``beam_size=1``) and carries no word
    timestamps: it exists to be cheap.
    """
    if not pcm:
        return None
    if _MODEL is None:
        _PARTIALS["dropped_cold"] += 1
        return None
    if final_is_waiting():
        _PARTIALS["dropped_for_final"] += 1
        return None
    if not _RUN_LOCK.acquire(blocking=False):
        _PARTIALS["dropped_busy"] += 1
        return None
    t0 = time.perf_counter()
    try:
        model = _MODEL
        if model is None:  # unloaded between the check and the lock
            _PARTIALS["dropped_cold"] += 1
            return None
        collected, detected = _decode(
            model, pcm16_to_float32(_at_target_rate(pcm, rate)),
            language=language, hotwords=hotwords, word_timestamps=False,
            beam_size=1)
    finally:
        _RUN_LOCK.release()
    _PARTIALS["run"] += 1
    return _assemble(collected, detected, time.perf_counter() - t0)


# ---------------------------------------------------------------------------
# HTTP — ElevenLabs Scribe-shaped
# ---------------------------------------------------------------------------
# NOT async: decodes and transcribes a whole recording (seconds to minutes of
# CPU). As a coroutine it would hold the event loop for the entire clip and
# stall every other request on the replica; `def` puts it on the threadpool.
@router.post("/v1/speech-to-text")
def speech_to_text(
    file: UploadFile = File(...),
    model_id: str = Form("scribe_v1"),
    language_code: str | None = Form(None),
    keywords: str | None = Form(None),
    diarize: bool = Form(False),
    speaker_threshold: float | None = Form(None),
    timestamps_granularity: str = Form("word"),
) -> dict:
    """Transcribe an uploaded recording.

    The response mirrors ElevenLabs Scribe so existing client code repoints with
    a base URL, with two differences this service will not paper over:

      * ``language_code`` is Whisper's two-letter code ("en"), not Scribe's
        three-letter one ("eng"). Inventing a mapping would make the field look
        interchangeable when the vocabularies are not.
      * ``diarize`` works (service/diarize.py), but the ``diarization`` block it
        returns says how far to trust itself: speaker BOUNDARIES are dependable,
        the speaker COUNT skews high, and synthetic speech confuses it outright.
        ``speaker_threshold`` tunes it; there is deliberately no "number of
        speakers" parameter, because the underlying one does not honour it.

    Each word additionally carries ``confidence`` — the model's own probability
    for that word, which Scribe does not return and this service refuses to
    throw away (see ``Word.confidence``). It is ``null``, never 0.0, when the
    backend rated no words: absent is not zero, and an editor that dims
    uncertain words must be able to tell "the model was unsure" from "nothing
    rated it" (the house rule, from service/verify.py).

    ``model_id`` is accepted for drop-in compatibility and ignored; which model
    runs is this replica's configuration (STT_MODEL), not the caller's choice.
    """
    raw = file.file.read()  # sync read — we're on the threadpool
    if not raw:
        raise HTTPException(400, "no audio in the upload")
    if len(raw) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, f"recording is larger than the "
                                 f"{MAX_UPLOAD_BYTES // (1024 * 1024)} MB upload limit")
    try:
        from faster_whisper.audio import decode_audio
    except ImportError as exc:
        raise HTTPException(503, _INSTALL_HINT) from exc
    try:
        audio = decode_audio(io.BytesIO(raw), sampling_rate=TARGET_RATE)
    except Exception as exc:  # noqa: BLE001 - a bad upload is the caller's problem
        raise HTTPException(400, f"could not decode this audio "
                                 f"({type(exc).__name__}). Send wav, mp3, m4a, "
                                 "ogg or flac.") from exc
    duration = len(audio) / TARGET_RATE
    if duration > SETTINGS.stt_max_clip_seconds:
        raise HTTPException(413, f"recording is {duration / 60:.1f} min, over the "
                                 f"{SETTINGS.stt_max_clip_seconds / 60:.0f} min limit")
    try:
        result = transcribe(
            audio, language=language_code, hotwords=keywords,
            # Diarization assigns speakers by overlapping word spans with
            # speaker turns, so it needs word timing even if the caller did not
            # ask for it in the response.
            word_timestamps=timestamps_granularity != "none" or diarize,
            # A whole recording is not waiting on a turn, so spend the beam.
            beam_size=max(SETTINGS.stt_beam_size, 5),
        )
    except SttUnavailable as exc:
        raise HTTPException(503, str(exc)) from exc

    speakers: dict = {"requested": bool(diarize)}
    if diarize:
        speakers.update(_diarize_words(audio, result, speaker_threshold))

    return {
        "language_code": result.language_code,
        "language_probability": result.language_probability,
        "text": result.text,
        "words": [{"text": w.text, "start": w.start, "end": w.end,
                   "type": "word", "speaker_id": w.speaker_id,
                   # Additive to the Scribe shape. None (JSON null) means the
                   # backend rated no words — NOT that it rated this one badly.
                   "confidence": w.confidence} for w in result.words],
        # Ours, not Scribe's: what it cost and how much to trust the speakers.
        "duration_s": result.duration_s,
        "transcribe_s": result.transcribe_s,
        "realtime_factor": result.realtime_factor(),
        "diarization": speakers,
    }


def _diarize_words(audio, result: Transcript, threshold: float | None) -> dict:
    """Label ``result``'s words with speakers, in place. Returns what happened.

    Never raises: diarization is an enrichment, and a recording that could be
    transcribed but not split is still worth returning. What went wrong is
    reported in the payload instead of replacing it with a 500.
    """
    from service import diarize as diarizer

    try:
        found = diarizer.diarize(audio, threshold=threshold)
    except diarizer.DiarizationUnavailable as exc:
        return {"available": False, "detail": str(exc)}
    except Exception as exc:  # noqa: BLE001 - reported, not fatal
        logger.exception("diarization failed")
        return {"available": False,
                "detail": f"diarization failed ({type(exc).__name__})"}

    if not found.turns:
        return {"available": True, "speakers": [], "turns": [],
                "detail": "no speaker turns were found in this recording"}

    for word in result.words:
        who = found.speaker_at(word.start, word.end)
        if who:
            word.speaker_id = who
    return {
        "available": True,
        "speakers": found.speakers,
        "turns": [{"start": t.start, "end": t.end, "speaker_id": t.speaker}
                  for t in found.turns],
        "diarize_s": found.diarize_s,
        # Load-bearing, and repeated wherever this travels: the boundaries are
        # dependable, the speaker COUNT skews high, and there is no way to pin
        # it (see service/diarize.py). `speaker_threshold` is the honest dial.
        "speaker_count_is_a_hypothesis": True,
        "threshold": threshold if threshold is not None else SETTINGS.diarize_threshold,
    }
