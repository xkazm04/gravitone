"""Who spoke when — local speaker diarization, no account required.

This is the gap ``stt.py`` opened and could not close. It could turn a recording
into words; it could not say which of two people said them, so every word came
back ``speaker_0`` and a two-voice recording was reported as one person talking
for ten minutes. That mattered twice over: a transcript of an interview wants
the roles separated, and the clone pipeline needs ONE speaker's audio picked out
of a recording that contains several.

**Why sherpa-onnx and not pyannote.** pyannote.audio has the best-known
pipelines and they are gated: using the pretrained weights means a HuggingFace
account, accepting terms, and a token in the environment. That is disqualifying
for a service whose entire claim is that it runs offline on a box you own with
no credentials. sherpa-onnx wraps the SAME segmentation model — pyannote
segmentation-3.0, MIT-licensed, re-exported to ONNX — plus a WeSpeaker CAM++
embedder, both served from plain GitHub releases with no auth. It also links its
own ONNX runtime, so this adds no torch dependency and competes with nothing.

    python -m service.diarize --download      # ~34 MB, once

WHAT IT ACTUALLY DOES, MEASURED
------------------------------
~11x faster than real time on this hardware. Accuracy was measured against
sherpa-onnx's own labelled fixtures (real recorded humans) and against synthetic
speech from this service's own voices, and the two disagree sharply:

=============================  ==============  ==============================
input                          truth -> found  verdict
=============================  ==============  ==============================
two-speakers-en (real)         2 -> 2          correct
four-speakers-zh (real)        4 -> 4          correct (at threshold 0.6)
six real speakers (4zh + 2en)  6 -> 6          correct — the table's old top
                                               was four, and four was not a
                                               ceiling
two TTS voices mixed           2 -> 3          WRONG: it split one voice in two
hiss bed, 25 dB SNR            2 -> 2          correct, but this is the knee —
                                               one noise draw of four collapsed
                                               here
hiss bed, 20 dB SNR            2 -> 1          WRONG: hiss collapses two people
                                               into one (3/3 draws)
tonal music bed, 10 and 0 dB   2 -> 2          correct — a HARMONIC bed is
                                               survivable at a level broadband
                                               hiss is not
crosstalk, 2 voices overlaid   2 -> 3          WRONG (over-counts)
crosstalk, 6 voices overlaid   6 -> 3          WRONG (collapses)
hiss / flat tone / digital     0 -> 0          correct: no phantom speaker
silence, no speech at all
tremolo'd tonal bed, no        0 -> 1          WRONG: 11 s of "speech" from
speech at all                                  music nobody spoke over
=============================  ==============  ==============================

Read the bottom half as one finding: **level and modulation, not the number of
people, are what break it.** Adding speakers does not (six were counted); a
sustained overlap or a broadband bed destroys the identity decision in opposite
directions; and a slow amplitude modulation over a tonal drone is enough to
manufacture a speaker out of a recording that contains no voice at all. Two
consequences a caller must carry: a hissy recording of two people comes back as
one person talking — the same wrong answer this module exists to stop returning,
arriving by a different road — and "1 speaker" is not evidence that anybody
spoke.

Provenance, because it decides how much these rows are worth: rows 1, 2 and the
TTS row are recordings. The six-speaker row is two real recordings back to back
(six genuinely different people, no overlap). The bed and crosstalk rows are
CONSTRUCTED — a bed summed under a real recording, or two real recordings summed
on top of each other. Summing is exactly what a noise bed does, so those rows
are worth what they say; summed crosstalk is NOT the same as a real co-located
recording of people talking over each other (no room, no shared microphone, and
nobody raising their voice to be heard), so treat those two rows as evidence
that overlap breaks the count and not as a measurement of how badly. Building
that fixture needs a recording this repo does not have; saying so is better than
publishing a number from a fixture that cannot support it. Every row above is
reproduced by ``test_diarize.RealAudioTests`` (``GRAVITONE_DIARIZE_E2E=1``).

So: **good on recorded humans, unreliable on synthetic speech.** Independently
expressive TTS output moves the speaker embedding more than one real person's
voice does, so two clips of the "same" synthetic voice can land further apart
than clips of two different ones. If you are diarizing this service's OWN output
(as its conversation recordings are), do not trust the speaker labels.

``DIARIZE_THRESHOLD`` is the dial, and 0.6 is not a guess — it is the only value
in a 0.4-0.8 sweep that got BOTH real fixtures exactly right (0.5 over-counted
the four-speaker file, 0.7 under-counted it). Boundaries were within ~100 ms of
the truth at every threshold; only the identity decision moves.

**There is no way to pin the speaker count, and this module does not pretend
otherwise.** sherpa-onnx's ``num_clusters`` was tested and does not produce the
number asked for — 2 gave 1, 4 gave 3, 3 gave 3 — so exposing it as
"num_speakers" would be an API that lies. The threshold is the honest knob.
Speaker counts still skew high, so ``count_is_certain`` is permanently False and
callers are expected to let a human correct the answer.
"""
from __future__ import annotations

import logging
import shutil
import threading
import time
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from service.config import SETTINGS

logger = logging.getLogger("gravitone.diarize")

TARGET_RATE = 16000

# Both from sherpa-onnx's release pages: no account, no token, no terms to
# accept. The embedding filename contains a literal "++", which MUST stay
# percent-encoded in the URL — naive concatenation of the display name 404s.
SEGMENTATION_URL = ("https://github.com/k2-fsa/sherpa-onnx/releases/download/"
                    "speaker-segmentation-models/"
                    "sherpa-onnx-pyannote-segmentation-3-0.tar.bz2")
EMBEDDING_URL = ("https://github.com/k2-fsa/sherpa-onnx/releases/download/"
                 "speaker-recongition-models/"
                 "wespeaker_en_voxceleb_CAM%2B%2B.onnx")
SEGMENTATION_FILE = "sherpa-onnx-pyannote-segmentation-3-0/model.onnx"
EMBEDDING_FILE = "wespeaker_en_voxceleb_CAM++.onnx"

_PIPELINE = None
_PIPELINE_KEY: tuple | None = None
_LOAD_LOCK = threading.Lock()
# One diarization at a time per process — same reasoning as stt.py and piper.py:
# the core budget is already pinned to the synthesis workers.
_RUN_LOCK = threading.Lock()

_INSTALL_HINT = (
    "speaker diarization needs sherpa-onnx, which is not installed. Install it "
    "with `pip install -r requirements.txt` (or `pip install sherpa-onnx`)."
)


@dataclass(frozen=True)
class Turn:
    """One span of one speaker."""

    start: float
    end: float
    speaker: str        # "speaker_0", "speaker_1", ...

    @property
    def seconds(self) -> float:
        return round(self.end - self.start, 3)


@dataclass
class DiarizationResult:
    turns: list[Turn] = field(default_factory=list)
    diarize_s: float = 0.0
    # Always False. See the module docstring: the boundaries are dependable, the
    # speaker COUNT is a hypothesis, and a field that could read True would
    # invite callers to treat it as settled.
    count_is_certain: bool = False

    @property
    def speakers(self) -> list[str]:
        return sorted({t.speaker for t in self.turns})

    def speaker_at(self, start: float, end: float) -> str | None:
        """Whose span overlaps [start, end] most. None if nothing does.

        Midpoint containment would be cheaper and wrong at exactly the moments
        that matter — a word straddling a speaker change belongs to whoever said
        most of it.
        """
        best, best_overlap = None, 0.0
        for turn in self.turns:
            overlap = min(end, turn.end) - max(start, turn.start)
            if overlap > best_overlap:
                best, best_overlap = turn.speaker, overlap
        return best


class DiarizationUnavailable(RuntimeError):
    """sherpa-onnx or its models are missing. Authored for the caller: the
    message says what to install or download."""


def models_dir() -> Path:
    return Path(SETTINGS.diarize_models_dir)


def segmentation_path() -> Path:
    return models_dir() / SEGMENTATION_FILE


def embedding_path() -> Path:
    return models_dir() / EMBEDDING_FILE


def models_present() -> bool:
    return segmentation_path().is_file() and embedding_path().is_file()


def available() -> bool:
    """Whether a diarization would work right now, without doing one."""
    try:
        import sherpa_onnx  # noqa: F401
    except ImportError:
        return False
    return models_present()


def info() -> dict:
    return {"models_dir": str(models_dir()), "models_present": models_present(),
            "available": available(),
            # Restated in every payload this appears in, on purpose.
            "speaker_count_is_a_hypothesis": True}


# ---------------------------------------------------------------------------
# Model fetch
# ---------------------------------------------------------------------------
def download(dest: Path | None = None) -> Path:
    """Fetch the two models. Idempotent; skips what is already there.

    Pure stdlib (urllib + tarfile) rather than shelling out to curl/tar: a bare
    Windows box has neither, and this is the one step an operator runs before
    anything works.
    """
    import bz2
    import tarfile
    import tempfile

    root = Path(dest) if dest else models_dir()
    root.mkdir(parents=True, exist_ok=True)

    if not embedding_path().is_file():
        logger.info("downloading the speaker embedding model (~29 MB)")
        _fetch(EMBEDDING_URL, root / EMBEDDING_FILE)
    if not segmentation_path().is_file():
        logger.info("downloading the speaker segmentation model (~7 MB)")
        with tempfile.TemporaryDirectory() as tmp:
            archive = Path(tmp) / "segmentation.tar.bz2"
            _fetch(SEGMENTATION_URL, archive)
            with bz2.open(archive) as raw, tarfile.open(fileobj=raw) as tar:
                # Extract members by name rather than tar.extractall(): an
                # archive is untrusted input, and a member path like
                # "../../etc" would otherwise write outside the models dir.
                for member in tar.getmembers():
                    if not member.isfile():
                        continue
                    target = (root / member.name).resolve()
                    if not str(target).startswith(str(root.resolve())):
                        logger.warning("skipping suspicious archive member %s",
                                       member.name)
                        continue
                    target.parent.mkdir(parents=True, exist_ok=True)
                    extracted = tar.extractfile(member)
                    if extracted is not None:
                        with open(target, "wb") as out:
                            shutil.copyfileobj(extracted, out)
    return root


def _fetch(url: str, target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    partial = target.with_suffix(target.suffix + ".part")
    with urllib.request.urlopen(url, timeout=120) as response, open(partial, "wb") as out:
        shutil.copyfileobj(response, out)
    partial.replace(target)  # atomic: a killed download never looks complete


# ---------------------------------------------------------------------------
# The pipeline
# ---------------------------------------------------------------------------
def _load(threshold: float):
    """The configured pipeline, rebuilt when the threshold changes.

    Clustering settings are baked into the config object, so a caller that tunes
    the threshold needs its own pipeline — hence the key.
    """
    global _PIPELINE, _PIPELINE_KEY
    key = (threshold, str(segmentation_path()), str(embedding_path()))
    if _PIPELINE is not None and _PIPELINE_KEY == key:
        return _PIPELINE
    with _LOAD_LOCK:
        if _PIPELINE is not None and _PIPELINE_KEY == key:
            return _PIPELINE
        try:
            import sherpa_onnx
        except ImportError as exc:
            raise DiarizationUnavailable(_INSTALL_HINT) from exc
        if not models_present():
            raise DiarizationUnavailable(
                f"the diarization models are not in {models_dir()}. Fetch them "
                "with `python -m service.diarize --download` (~34 MB, no account "
                "needed).")
        t0 = time.perf_counter()
        config = sherpa_onnx.OfflineSpeakerDiarizationConfig(
            segmentation=sherpa_onnx.OfflineSpeakerSegmentationModelConfig(
                pyannote=sherpa_onnx.OfflineSpeakerSegmentationPyannoteModelConfig(
                    model=str(segmentation_path())),
                num_threads=SETTINGS.diarize_threads,
            ),
            embedding=sherpa_onnx.SpeakerEmbeddingExtractorConfig(
                model=str(embedding_path()),
                num_threads=SETTINGS.diarize_threads),
            # num_clusters stays -1 (threshold-driven) always: see the module
            # docstring — asking for N clusters does not yield N.
            clustering=sherpa_onnx.FastClusteringConfig(num_clusters=-1,
                                                        threshold=threshold),
            min_duration_on=SETTINGS.diarize_min_speech_s,
            min_duration_off=SETTINGS.diarize_min_silence_s,
        )
        try:
            pipeline = sherpa_onnx.OfflineSpeakerDiarization(config)
        except Exception as exc:  # noqa: BLE001 - a load failure must SAY so
            raise DiarizationUnavailable(
                f"could not build the diarization pipeline "
                f"({type(exc).__name__}: {exc}). Re-run "
                "`python -m service.diarize --download`.") from exc
        logger.info("diarization pipeline loaded in %.2fs",
                    time.perf_counter() - t0)
        _PIPELINE, _PIPELINE_KEY = pipeline, key
        return _PIPELINE


def diarize(audio: "np.ndarray", *,
            threshold: float | None = None) -> DiarizationResult:
    """Split ``audio`` (float32 mono at 16 kHz, in [-1, 1]) into speaker turns.

    ``threshold`` is the cosine distance at which two voices are called
    different people — the only knob that genuinely moves the answer. Lower
    splits more, higher merges more; see the module docstring for the sweep that
    produced the default.

    Blocking; call it on a thread.
    """
    if audio is None or len(audio) == 0:
        return DiarizationResult()
    pipeline = _load(SETTINGS.diarize_threshold if threshold is None else threshold)
    samples = np.ascontiguousarray(audio, dtype=np.float32)
    t0 = time.perf_counter()
    with _RUN_LOCK:
        raw = pipeline.process(samples).sort_by_start_time()
    # Renumber by order of first appearance. The clusterer's own ids are
    # arbitrary and sparse — a two-speaker recording came back labelled 0 and 8 —
    # which reads to a caller like six speakers went missing.
    order: dict[int, int] = {}
    turns = []
    for s in raw:
        cluster = int(s.speaker)
        if cluster not in order:
            order[cluster] = len(order)
        turns.append(Turn(start=round(float(s.start), 3), end=round(float(s.end), 3),
                          speaker=f"speaker_{order[cluster]}"))
    result = DiarizationResult(turns=turns,
                              diarize_s=round(time.perf_counter() - t0, 3))
    logger.info("diarized %.1fs into %d turn(s) across %d speaker(s) in %.2fs",
                len(samples) / TARGET_RATE, len(turns), len(result.speakers),
                result.diarize_s)
    return result


def _main(argv: list[str] | None = None) -> int:
    import argparse

    parser = argparse.ArgumentParser(
        description="Speaker diarization models and a one-off check.")
    parser.add_argument("--download", action="store_true",
                        help="fetch the models into the configured directory")
    parser.add_argument("audio", nargs="?", help="a wav file to diarize")
    parser.add_argument("--threshold", type=float, default=None,
                        help="voice-distance threshold (lower splits more; "
                             "default from DIARIZE_THRESHOLD)")
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(message)s")
    if args.download:
        print(f"models ready in {download()}")
    if not args.audio:
        return 0

    from faster_whisper.audio import decode_audio

    result = diarize(decode_audio(args.audio, sampling_rate=TARGET_RATE),
                     threshold=args.threshold)
    for turn in result.turns:
        print(f"  {turn.start:7.2f} -> {turn.end:7.2f}  {turn.speaker}")
    print(f"{len(result.speakers)} speaker(s) — a hypothesis, not a measurement "
          "(see service/diarize.py)")
    return 0


if __name__ == "__main__":
    raise SystemExit(_main())
