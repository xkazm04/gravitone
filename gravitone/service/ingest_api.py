"""HTTP surface for the Character-ingestion flow (with speaker selection).

  POST /v1/ingest/scan                      (file) → { job_id }  [analyze: transcribe+isolate]
  GET  /v1/ingest/{job}                     → { status, step, steps[], partial, speakers, result }
  GET  /v1/ingest/{job}/speaker-preview/{id}→ per-speaker sample wav
  POST /v1/ingest/{job}/speaker             { speaker_id }  [start label+stem for that speaker]
  GET  /v1/ingest/{job}/preview/{emotion}   → stem wav (the SPEAKER's own audio)
  GET  /v1/ingest/{job}/segment/{i}         → ONE labelled segment's wav
  POST /v1/ingest/{job}/stems               { assignments, reset? } → re-spliced stems
  POST /v1/ingest/{job}/audition            { emotion, text, recipe? } → wav (a CLONE)
  POST /v1/ingest/{job}/commit              { character, emotions[], character_id?,
                                              recipes?, corpus? } → voices
  POST /v1/ingest/rederive                  { character_id, emotions? } → { job_id }
  GET  /v1/characters/{id}/corpus           → what audio of this person is kept
  DELETE /v1/characters/{id}/corpus/{sha}   → remove every segment from one clip

The corpus (`service/ingest.py`, "THE VOICE CORPUS"): OPT-IN per job (`corpus:
true` on the scan or the commit, default OFF), captured only after a commit that
really created Voices, and only when that commit carried an ownership
attestation. `rederive` rebuilds a character's stems from everything the corpus
holds and re-exports through the same one-load child a commit uses — it is a
JOB, not a blocking call, for exactly the reason commit is one.

Status flow: running → awaiting_speaker → running → done. `partial` streams live
intermediate data (word count, speakers, per-emotion tally) for a data-rich loader.

Durability: every job owns a subdir under INGEST_WORK_DIR holding its files and a
`state.json` mirror of the job dict. All JOBS mutations happen under a single
in-process lock, and every `state.json` write goes through `atomicio` — the
cross-process mutex plus a per-process temp name — because INGEST_WORK_DIR is
shared by all N replica processes. At startup we CLAIM and rehydrate the jobs
no live replica owns (marking any job caught mid-flight by the restart as
errored) and start a background thread that beats this process's liveness and
expires IDLE jobs (and orphan workdirs) on a timer — a job that is actively
working only ages out on the far longer wedged threshold, so GC never deletes a
workdir under a running thread, and never deletes another replica's at all.
See "ownership across replicas" below.

Abandonment: `job["cancel"]` is the single teardown flag, and EVERY phase honours
it — analyze polls it before each paid call, labelling before each segment,
commit between emotions. A commit that is cancelled OR that fails rolls back the
Voices it had already registered (`_rollback`), because registration happens per
stem and both paths otherwise leave a partial Character behind. Phase failures
reach the client through `errors.sanitize_detail`, never as raw tool output.

Admission: `Settings.ingest_max_jobs` bounds how many jobs may be working at
once; the phase-starting routes answer 429 above it. Auditions are admitted
SEPARATELY (`_audition_slot`): they hold no job slot, because an audition is a
read-only experiment on a finished scan and queueing one behind two long scans
would make "hear it first" unavailable exactly when someone is deciding.

Auditions (the Audition Room): `/preview/{emotion}` serves the SOURCE stem — the
speaker's own spliced audio — and always has. `/audition` serves a CLONE of a
candidate stem speaking a chosen line: a throwaway voice, exported and spoken in
one child process, never registered in the roster, deleted before the response is
written. Candidate stems come from `recipes`: 2-3 deterministic splices per
emotion computed from the segment labels the scan already produced, so a user can
compare "all of it" against "the longest takes" against "the cleanest signal"
before anything irreversible happens. `commit` re-splices to the chosen recipe.

The Casting Board (`/segment/{i}` + `/stems`): a stem used to be an opaque
aggregate — one number on screen for a splice of segments nobody could hear or
change. `/segment/{i}` serves one labelled segment's own wav (the sibling of
`speaker-preview`), and `/stems` re-runs `concat_wavs` over a caller-supplied
`{emotion: [segment indices]}` map, rewriting `stem_{emotion}.wav` IN THE
WORKDIR and reporting the new seconds/eligibility. It writes nothing to the
roster, it cannot reach a filename (emotions are normalized, indices are ints
validated against this scan's own segments), and `reset` restores the splice
the pipeline proposed. Editing an emotion WITHDRAWS its candidate recipes —
they were alternative readings of the proposed selection and "everything" no
longer means what they were built from — so an audition of an edited emotion
hears exactly the stem now on disk. Cross-recording pooling is NOT here: the
corpus (below) is the seam that would carry it.
"""
from __future__ import annotations

import contextlib
import hashlib
import json
import logging
import os
import shutil
import subprocess
import threading
import time
import uuid
import wave
from pathlib import Path
from typing import Callable, Iterator

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel

from service import atomicio, errors, export_stems, ingest, observability, ratelimit, voices
from service.config import SETTINGS
from service.emotions import normalize_emotion
from service.errors import job_expired

logger = logging.getLogger("gravitone")

# ONE router, NO prefix — deliberately. This module owns two path families:
# `/v1/ingest/...` (the scan → review → commit flow) and
# `/v1/characters/{id}/corpus...` (what audio of a person the box kept, and the
# deletion surface for it). They are the same capability and the same "clone"
# scope, so they ride the same router `service/app.py` already mounts; a second
# router would need a second mount and would let the corpus surface ship
# unwired. Every path below is therefore written out in full.
router = APIRouter(tags=["ingest"])
INGEST = "/v1/ingest"

# Same step KEYS in both modes (the web loader keys off them); only the
# labels differ. Sovereign = local-only ffmpeg pipeline, no network I/O.
STEPS_BY_MODE = {
    "cloud": [
        {"key": "transcribe", "label": "Transcribe & diarize"},
        {"key": "isolate", "label": "Isolate voice"},
        {"key": "label", "label": "Detect emotions"},
        {"key": "stem", "label": "Build emotion stems"},
    ],
    "sovereign": [
        {"key": "isolate", "label": "Clean audio (local)"},
        {"key": "transcribe", "label": "Detect speech (local)"},
        {"key": "label", "label": "Group segments (local)"},
        {"key": "stem", "label": "Build voice stem"},
    ],
    # Re-derivation has no recording to analyze: it selects from stored audio
    # and clones. Same step-key shape so the studio's loader needs no new case.
    "rederive": [
        {"key": "stem", "label": "Rebuild stems from the corpus"},
        {"key": "clone", "label": "Re-export voices"},
    ],
}
# Modes a caller may ASK for on /scan. "rederive" is a mode this service enters
# by its own route, never by upload — kept off this tuple so the scan surface
# cannot be talked into it.
SCAN_MODES = ("auto", "cloud", "sovereign")

# ── durable job store ─────────────────────────────────────────────────────────
JOBS: dict[str, dict] = {}
# Guards every JOBS mutation. It is NOT the whole story: this service ships as N
# single-worker processes (service/replicas.py), so an RLock serializes this
# process against itself and nothing against the other replicas that write the
# same `state.json` files. Cross-PROCESS exclusion is `atomicio.file_lock`,
# taken by `_persist` and by `_claim` — see "ownership across replicas" below.
_LOCK = threading.RLock()
WORK_ROOT = Path(SETTINGS.ingest_work_dir)
_TTL = 60 * 30                     # idle jobs (and their workdirs) expire after 30 min
_GC_INTERVAL = 60 * 5             # background GC sweep cadence
# Set by `stop_background`; every background thread this module owns watches it.
# A daemon thread is not a drain: SIGTERM used to kill a commit mid-clone with
# rows already registered and `_rollback` still ten lines away.
_STOP = threading.Event()
# Phase threads (analyze/label/commit/rederive) currently in flight, so the
# drain has something to join. Guarded by _LOCK; pruned as it grows.
_PHASES: "list[threading.Thread]" = []
# The real class, captured at import: suites that patch `threading.Thread` hand
# `_spawn` a stand-in, and a drain must join threads, not a mock's is_alive().
_REAL_THREAD = threading.Thread

# Statuses that mean "a thread is doing work for this job right now". They are
# what the admission gate counts and what GC refuses to reap on the idle TTL.
ACTIVE_STATUSES = ("running", "committing")
# The only TTL an ACTIVE job can hit. Expiry is measured from the last state
# mutation (`touched`), not from creation: a cloud scan of a long recording, or
# a commit started 25 minutes after the scan, used to be reaped mid-phase by the
# creation-age TTL — the workdir was deleted out from under a thread that was
# still writing into it. A job that has genuinely made no progress for this long
# is wedged, and IS reaped (with the cancel flag set first, as always).
_RUNNING_TTL = 60 * 120
# Bounded concurrency: nothing used to stop N uploads spawning N unbounded
# fan-outs of ffmpeg + paid cloud calls. See Settings.ingest_max_jobs.
#
# This number is the POOL's budget, not one process's. It used to be counted per
# process, so a box running TTS_REPLICAS=4 admitted 4x what the operator
# configured while the 429 quoted the single number — the same lie
# `service/ratelimit.py` fixed for the per-IP budgets. See `admission_shape`.
MAX_ACTIVE_JOBS = SETTINGS.ingest_max_jobs
# How long a refused caller is told to wait. Coarse on purpose: the work that
# holds a slot is a whole scan or commit (minutes), so any precise-looking
# number would be a guess dressed as an ETA. See `_admit`.
ADMISSION_RETRY_AFTER_S = 5


# ── ownership across replicas ─────────────────────────────────────────────────
# One box, many processes, ONE truth per job.
#
# `WORK_ROOT` is shared by every replica. Before this, `_rehydrate` loaded EVERY
# `state.json` under it into EVERY process, so N processes each held a mutable
# copy of the same job, each ran its own phase threads against the same workdir,
# and `_gc_once` reaped directories a sibling replica was still writing into.
# `os.replace` prevents a torn file; it does not prevent two owners.
#
# So a job is OWNED. The owner record lives in the job's own directory
# (`owner.json`) and is written under `atomicio.file_lock` — the O_CREAT|O_EXCL
# cross-process mutex — so the claim itself cannot race: exactly one process
# wins, the losers do not load the job at all (the deployment is already
# replica-affine for ingest; see deploy/README.md).
#
# Liveness is a per-PROCESS heartbeat file, not a pid check: `os.kill(pid, 0)`
# is not portable to the Windows dev box, and a recycled pid would let a fresh
# process inherit a dead one's jobs. A process refreshes its beat every
# `_BEAT_INTERVAL` from the GC thread and deletes it on a clean shutdown, so an
# owner is "gone" when its beat is missing or older than `_OWNER_STALE_S`. Only
# then may its jobs be claimed or its workdirs reaped.
OWNER = f"{os.getpid()}-{uuid.uuid4().hex[:8]}"
_OWNERS_DIRNAME = ".owners"
_BEAT_INTERVAL = 15.0
_OWNER_STALE_S = 60.0
# A beat file whose process never came back is swept on this much longer clock,
# so the directory cannot grow without bound across restarts.
_BEAT_TTL_S = 60 * 60
# Claiming is a fast, uncontended lock (one O_EXCL create). A long wait here
# would stall startup for every job on disk, and failing to claim is SAFE —
# the job stays owned by whoever has it.
_CLAIM_TIMEOUT_S = 2.0
# Names under WORK_ROOT that are infrastructure, not jobs.
_RESERVED_DIRS = (_OWNERS_DIRNAME, ".receipts")


def _owners_dir() -> Path:
    return WORK_ROOT / _OWNERS_DIRNAME


def _beat_path(owner: str = OWNER) -> Path:
    return _owners_dir() / f"{owner}.alive"


def _beat() -> None:
    """Say this process is still here. Best effort: a box whose work root is
    momentarily unwritable must not crash the sweeper — it will simply look
    dead, and looking dead only ever costs ownership, never correctness."""
    try:
        _owners_dir().mkdir(parents=True, exist_ok=True)
        _beat_path().write_text(str(time.time()), "utf-8")
    except OSError as exc:
        logger.warning("ingest: owner heartbeat failed: %s", exc)


def _release_owner() -> None:
    """Drop this process's beat. A cleanly-stopped replica is gone IMMEDIATELY
    rather than after `_OWNER_STALE_S`, which is what makes a restart adopt its
    predecessor's jobs at once instead of leaving them stranded."""
    with contextlib.suppress(OSError):
        _beat_path().unlink(missing_ok=True)


def _owner_alive(owner: str) -> bool:
    """Is `owner` a process that is still running? Unknown owners are DEAD:
    an owner record with no beat behind it is exactly what a crash leaves."""
    if not owner:
        return False
    if owner == OWNER:
        return True
    try:
        age = time.time() - _beat_path(owner).stat().st_mtime
    except OSError:
        return False
    return age <= _OWNER_STALE_S


def _owner_of(job_dir: Path) -> str | None:
    try:
        rec = json.loads((job_dir / "owner.json").read_text("utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return rec.get("owner") if isinstance(rec, dict) else None


def _write_owner(job_dir: Path) -> None:
    """Stamp this process onto a job directory it already owns by construction
    (it just created it under a fresh uuid — no other process can name it)."""
    with contextlib.suppress(OSError):
        atomicio.atomic_write_text(
            job_dir / "owner.json",
            json.dumps({"owner": OWNER, "pid": os.getpid(),
                        "claimed_at": time.time()}))


def _claim(job_dir: Path) -> bool:
    """Take ownership of a job directory, or report that somebody live has it.

    The read-check-write is done under the cross-process mutex, so two replicas
    rehydrating the same root at the same instant cannot both win. Fails CLOSED:
    a lock we could not take means we do not claim, because two owners is the
    bug this exists to prevent and one stranded job is not.
    """
    try:
        with atomicio.file_lock(job_dir / ".owner.lock", timeout=_CLAIM_TIMEOUT_S):
            current = _owner_of(job_dir)
            if current and _owner_alive(current) and current != OWNER:
                return False
            atomicio.atomic_write_text(
                job_dir / "owner.json",
                json.dumps({"owner": OWNER, "pid": os.getpid(),
                            "claimed_at": time.time()}))
            return True
    except (OSError, TimeoutError) as exc:
        logger.warning("ingest: could not claim %s (%s); leaving it alone",
                       job_dir.name, exc)
        return False


def admission_shape(total: int, replicas: int | None = None) -> tuple[int, int, int]:
    """(per-replica slots, what the POOL really allows, replica count).

    The alternative was a file-backed cross-process count. It was rejected: a
    concurrency slot has to be RELEASED, so a replica killed mid-scan leaks a
    slot until some reaper decides it is stale — a whole second liveness
    protocol, on the admission path, to save an integer division. Dividing the
    configured budget by the replica count needs no release path at all, and
    the only thing it owes the caller is honesty about the arithmetic, which
    `_admit` pays (the `describe()` precedent from service/ratelimit.py).

    Trade-off, stated: the share is floored at 1, so a pool budget SMALLER than
    the replica count (2 jobs, 4 replicas) admits one per replica — 4, not 2.
    The 429 says 4 in that deployment rather than quoting a 2 nobody enforces.
    """
    n = max(1, int(replicas if replicas is not None else ratelimit.replica_count()))
    total = int(total)
    if total <= 0:
        # A budget of zero is an operator saying "not on this box". Flooring it
        # at one per replica would hand it back the surface it switched off.
        return 0, 0, n
    return max(1, total // n), max(1, total // n) * n, n


# ── auditions ─────────────────────────────────────────────────────────────────
# How many auditions may be synthesizing at once, ACROSS jobs. Deliberately its
# own budget rather than a job slot: an audition neither transcribes nor
# registers anything, it is a finished scan being sampled, and the whole feature
# is worthless if it is unavailable while somebody else's scan runs. It is still
# bounded, because each one is a real CPU model load in a child process.
MAX_ACTIVE_AUDITIONS = 2
AUDITION_RETRY_AFTER_S = 8
# One cold model load (~15s) plus one line of CPU synthesis. Generous, and a
# timeout is REPORTED as a timeout (export_stems.audition names it).
AUDITION_TIMEOUT_S = 240.0
# The line a candidate speaks when the caller does not choose one. Short, plainly
# declarative, and emotionally uncommitted, so the recipe is what differs between
# two takes rather than the reading.
DEFAULT_AUDITION_TEXT = "This is how I sound when I say something I mean."
MAX_AUDITION_TEXT = 240
_audition_lock = threading.Lock()
_active_auditions = 0


@contextlib.contextmanager
def _audition_slot() -> Iterator[None]:
    """Cheap admission for one audition. 429 (named, with Retry-After) when the
    audition budget is full — never counted against, and never blocked by,
    `MAX_ACTIVE_JOBS`. Released in a `finally`, so a failed synthesis cannot
    strand the budget the way a leaked counter would."""
    global _active_auditions
    per, pool, replicas = admission_shape(MAX_ACTIVE_AUDITIONS)
    with _audition_lock:
        if _active_auditions >= per:
            raise HTTPException(
                429, f"{_active_auditions} audition(s) are already being "
                     "synthesized on the CPU engine"
                     + (f" by this replica (the box runs {replicas} of them and "
                        f"synthesizes at most {pool} auditions at once)"
                        if replicas > 1 else "")
                     + " — try again in a moment",
                headers={"Retry-After": str(AUDITION_RETRY_AFTER_S)})
        _active_auditions += 1
    try:
        yield
    finally:
        with _audition_lock:
            _active_auditions -= 1


# ── recipes ───────────────────────────────────────────────────────────────────
# A recipe is one DETERMINISTIC way to splice an emotion's segments into a stem.
# The scan already knows each segment's emotion, confidence, duration and levels;
# collapsing all of that into a single stem threw away every alternative reading
# of the same recording. These are those alternatives, named:
#
#   full       every usable segment, recording order — what the ledger shows and
#              what commit has always cloned. Always present, always the default.
#   longest    the longest takes only — sustained phonation teaches a voice more
#              than a pile of two-word fragments.
#   confident  only the segments the classifier was most sure about — a stem with
#              no mislabelled audio in it, at the cost of length.
#   tightest   the best speech-to-noise-floor segments (`ingest.measure_levels`,
#              the same measurement the sovereign path takes) — drops the noisy
#              spans rather than the short ones.
#
# Determinism is a contract, not an accident: every ordering breaks ties on the
# segment index, so the same job produces the same recipes on every rebuild, and
# a test can assert the exact index sets.
RECIPE_FULL = "full"
RECIPE_ORDER = (RECIPE_FULL, "longest", "confident", "tightest")
RECIPE_LABELS = {
    RECIPE_FULL: ("everything", "every usable segment, in recording order"),
    "longest": ("longest takes", "the longest segments only — more sustained speech"),
    "confident": ("surest labels", "only the segments the classifier was most sure about"),
    "tightest": ("cleanest signal", "the segments with the most speech above the noise floor"),
}
# 3 = the default plus two alternatives. Beyond that an A/B becomes a menu, and
# the proposal's own risk note is decision fatigue on the critical path.
MAX_RECIPES_PER_EMOTION = 3
# How much audio a subset recipe aims for before it stops adding segments. The
# floor is the backend's own clone minimum, so no alternative is offered that is
# knowably too short to commit; above that a little headroom beats a bare pass.
RECIPE_TARGET_SECONDS = 8.0
# ...but never so much of what is available that every "subset" is the whole set.
# A target at or above the emotion's total length makes each ordering select
# everything, the variants collapse into `full`, and the drill-down silently
# disappears on exactly the recordings it was built for (a 6s stem). The share is
# therefore relative to what this emotion actually has.
RECIPE_TARGET_SHARE = 0.7


def _wav_seconds(path: Path) -> float:
    try:
        with wave.open(str(path), "rb") as w:
            return round(w.getnframes() / w.getframerate(), 2)
    except (OSError, wave.Error):
        return 0.0


# ── the per-job segment-metrics memo ──────────────────────────────────────────
# One scan's segment wavs get measured over and over. `segment_rows` opens each
# one for its duration; `_variants` runs `ingest.measure_levels` — a FULL
# frame-RMS decode of the file — over every candidate to order the `tightest`
# recipe; and `_board` re-runs `segment_rows` on every /stems call (a debounce
# target: the studio fires one per drag) and again at commit. A `reset` re-runs
# `build_recipes` end to end, so the whole decode pass repeats.
#
# What is actually expensive, stated precisely rather than repeated from the
# proposal: `_wav_seconds` is a HEADER read (wave.open + getnframes), cheap but
# repeated once per segment per call; `ingest.measure_levels` streams and
# squares every frame, and that is the pass worth never taking twice.
#
# Both answers are pure functions of BYTES ON DISK, so the memo is keyed on the
# file's (size, mtime_ns) rather than invalidated by a protocol. That is the
# design choice, and it is the one the flow's own facts argue for: `/stems`
# rewrites `stem_{emotion}.wav`, never `seg_%03d.wav` — a segment wav is written
# once by the label phase and never touched again — so a re-splice has NOTHING
# to invalidate. Rather than encode that as an assumption, a `stat` per lookup
# (microseconds against a decode) makes the memo self-invalidating: if anything
# ever does rewrite a segment, the next reader measures the new bytes.
#
# LOCKING: `_METRICS_LOCK` is a LEAF. Nothing is acquired while it is held, and
# the measurement itself runs OUTSIDE it — so it cannot participate in the
# `_STEM_LOCK` → `_LOCK` order that `restem` and `commit` depend on, and a slow
# decode never blocks another job's lookup. Two threads racing the same miss
# both measure and both store; the functions are deterministic, so the loser
# writes the identical answer.
_METRICS_LOCK = threading.Lock()
# work_dir -> wav path -> {"key": (size, mtime_ns), "seconds": ..., "levels": ...}
_METRICS: dict[str, dict[str, dict]] = {}


def _stat_key(path: Path) -> tuple[int, int] | None:
    try:
        st = path.stat()
    except OSError:
        return None
    return (st.st_size, st.st_mtime_ns)


def _metric(work_dir: Path, wav: Path, name: str, compute: Callable[[Path], object]):
    """One memoized measurement of one segment wav.

    A miss (or a file whose bytes changed) measures OUTSIDE the lock and stores
    the result against the current stat key. A file that cannot be stat'd is
    measured and NOT cached — there is nothing to key it on, and answering from
    a stale entry for a file that has gone is worse than paying for the read.
    """
    key = _stat_key(wav)
    wd, path = str(work_dir), str(wav)
    if key is not None:
        with _METRICS_LOCK:
            entry = _METRICS.get(wd, {}).get(path)
            if entry is not None and entry["key"] == key and name in entry:
                return entry[name]
    value = compute(wav)
    if key is None:
        return value
    with _METRICS_LOCK:
        per_job = _METRICS.setdefault(wd, {})
        entry = per_job.get(path)
        if entry is None or entry["key"] != key:
            entry = per_job[path] = {"key": key}
        entry[name] = value
    return value


def segment_seconds(work_dir: Path, wav: Path) -> float:
    """This segment's duration, measured once per job."""
    return float(_metric(work_dir, wav, "seconds", _wav_seconds))


def segment_levels(work_dir: Path, wav: Path) -> "ingest.Levels":
    """This segment's speech/floor/threshold levels, decoded once per job."""
    return _metric(work_dir, wav, "levels", ingest.measure_levels)


def forget_metrics(work_dir: str | Path) -> None:
    """Drop a job's memo. Called wherever its workdir is rmtree'd, so the memo
    cannot outlive the audio it describes (it is keyed by path, and job ids —
    hence paths — are not reused, but an unbounded dict on a long-lived replica
    is a leak whether or not it is ever read again)."""
    with _METRICS_LOCK:
        _METRICS.pop(str(work_dir), None)


def segment_rows(work_dir: Path, result: dict) -> tuple[list[dict], str | None]:
    """The scan's per-segment labels re-joined to their extracted wavs.

    `label_and_stem` reports segments in index order but publishes neither the
    index nor the wav path, so the join is positional — and a positional join
    that is wrong would silently splice the wrong audio into a recipe. It is
    therefore VERIFIED: each row's labelled duration must match the wav on disk
    (they are the same span, extracted by `to_wav`). A mismatch abandons recipes
    entirely with a named reason rather than offering candidates built from
    misattributed audio.

    Returns (rows, reason-recipes-are-unavailable).
    """
    segs = result.get("segments")
    if not isinstance(segs, list) or not segs:
        return [], "no per-segment labels on this scan"
    rows: list[dict] = []
    for i, s in enumerate(segs):
        wav = work_dir / f"seg_{i:03d}.wav"
        if not wav.is_file():
            # A segment that failed extraction has no audio and feeds no stem —
            # exactly as the pipeline's own `usable` filter treats it.
            if not s.get("failure"):
                return [], "segment audio is missing for this scan"
            continue
        seconds = segment_seconds(work_dir, wav)
        declared = float(s.get("dur") or 0.0)
        if declared and abs(seconds - declared) > 0.35:
            return [], "segment audio could not be matched to its labels"
        if s.get("failure"):
            continue
        if s.get("outlier") == "dropped":
            # The pipeline measured this segment as not the target speaker and
            # removed it from every stem (ingest.label_and_stem). A recipe that
            # re-introduced it would quietly undo that decision — and "the user
            # picked it" is not consent to clone a bystander. "flagged" segments
            # ARE in the stems, so they stay candidates.
            continue
        rows.append({"i": i, "wav": str(wav), "emotion": s.get("emotion"),
                     "confidence": float(s.get("confidence") or 0.0),
                     "seconds": seconds})
    if not rows:
        return [], "no usable segments on this scan"
    return rows, None


def _prefix_to_target(cands: list[dict], order: list[dict], target: float) -> list[dict]:
    """Take segments in `order` until `target` seconds are covered, then return
    them in RECORDING order. The selection is by merit; the splice is always
    chronological, because `concat_wavs` level-matches and crossfades a sequence
    and re-ordering utterances is the one thing that makes a stem sound assembled."""
    picked: list[dict] = []
    have = 0.0
    for row in order:
        if have >= target:
            break
        picked.append(row)
        have += row["seconds"]
    return sorted(picked, key=lambda r: r["i"])


def _variants(work_dir: Path, cands: list[dict],
              target: float) -> list[tuple[str, list[dict]]]:
    """Every candidate splice for one emotion, in offer order. A variant that
    would be identical to one already offered is not offered — an A/B between two
    identical takes is a fake choice, and this flow's whole problem was fake
    information about audio."""
    out: list[tuple[str, list[dict]]] = [(RECIPE_FULL, cands)]
    if len(cands) >= 2:
        out.append(("longest", _prefix_to_target(
            cands, sorted(cands, key=lambda r: (-r["seconds"], r["i"])), target)))
        confs = {r["confidence"] for r in cands}
        if len(confs) > 1:
            # All-equal confidence (sovereign mode labels everything 1.0) would
            # make "surest labels" a lie dressed as a measurement.
            out.append(("confident", _prefix_to_target(
                cands, sorted(cands, key=lambda r: (-r["confidence"], r["i"])), target)))
        snr: list[tuple[float, dict]] = []
        for r in cands:
            lv = segment_levels(work_dir, Path(r["wav"]))
            if lv.measured:
                snr.append((lv.speech_db - lv.floor_db, r))
        if len(snr) == len(cands) and len(cands) >= 3:
            out.append(("tightest", _prefix_to_target(
                cands, [r for _, r in sorted(snr, key=lambda t: (-t[0], t[1]["i"]))], target)))

    seen: set[tuple[int, ...]] = set()
    deduped: list[tuple[str, list[dict]]] = []
    for kind, rows in out:
        key = tuple(r["i"] for r in rows)
        if not key or key in seen:
            continue
        seen.add(key)
        deduped.append((kind, rows))
    return deduped[:MAX_RECIPES_PER_EMOTION]


def build_recipes(work_dir: Path, result: dict) -> tuple[dict[str, dict[str, list[int]]], str | None]:
    """Compute + splice the candidate stems for a finished scan, IN PLACE.

    Grows every `result["stems"][*]` entry with `recipes: [{id, label, how,
    seconds, segments, default}]` and writes one `stem_{emotion}__{id}.wav` per
    non-default recipe (the default recipe IS `stem_{emotion}.wav`, already on
    disk and already measured — it is never re-spliced, so the number the ledger
    showed stays the number the ledger shows).

    Returns (plan, reason) where `plan` is `{emotion: {recipe_id: [segment
    indices]}}` — kept on the job and NEVER published: a client names a recipe by
    id, so no caller can ever hand this service a segment selection of its own.
    `reason` names a degraded outcome for the payload; recipes are advisory and
    their absence must never fail a scan.
    """
    stems = result.get("stems")
    if not isinstance(stems, list) or not stems:
        return {}, "this scan produced no stems"
    rows, reason = segment_rows(work_dir, result)
    if reason:
        return {}, reason

    min_stem = float(result.get("min_stem") or ingest.MIN_STEM_SECONDS)
    by_emotion: dict[str, list[dict]] = {}
    for r in rows:
        by_emotion.setdefault(r["emotion"], []).append(r)

    plan: dict[str, dict[str, list[int]]] = {}
    for stem in stems:
        emo = stem.get("emotion")
        if emo == ingest.BASELINE:
            # The baseline stem is not "the neutral segments": plan_baseline may
            # have topped it up from other emotions to clear the minimum, and it
            # reports that. Recipes must start from the SAME material the shipped
            # stem started from, or "everything" would mean something different
            # here than it does one row above.
            cands = list(ingest.plan_baseline(by_emotion, min_stem).labs)
            for c in cands:
                c.setdefault("seconds", segment_seconds(work_dir, Path(c["wav"])))
        else:
            cands = sorted(by_emotion.get(emo, []), key=lambda r: r["i"])
        if len(cands) < 2:
            continue   # one segment has exactly one splice; absent = invisible
        total = sum(c["seconds"] for c in cands)
        target = max(min_stem, min(RECIPE_TARGET_SECONDS, total * RECIPE_TARGET_SHARE))

        offers: list[dict] = []
        for kind, sel in _variants(work_dir, cands, target):
            label, how = RECIPE_LABELS[kind]
            if kind == RECIPE_FULL:
                seconds, segments = stem.get("seconds"), stem.get("segments")
            else:
                dst = work_dir / f"stem_{emo}__{kind}.wav"
                try:
                    sp = ingest.concat_wavs([Path(r["wav"]) for r in sel], dst)
                except Exception as exc:  # noqa: BLE001 - one recipe, never the scan
                    logger.warning("recipe %s/%s could not be spliced: %s", emo, kind, exc)
                    continue
                seconds, segments = sp.seconds, sp.segments
            offers.append({"id": kind, "label": label, "how": how,
                           "seconds": seconds, "segments": segments,
                           "default": kind == RECIPE_FULL})
            plan.setdefault(emo, {})[kind] = [r["i"] for r in sel]
        if len(offers) > 1:
            # A lone "everything" is not a choice worth rendering.
            stem["recipes"] = offers
        else:
            plan.pop(emo, None)
    return plan, None


# One external-spend ledger per job, shared by its analyze and label phases so
# the retry/escalation budgets are per JOB (the point of them) and the reported
# cost is the whole job's. Per process, exactly like JOBS.
_SPEND: dict[str, ingest.Spend] = {}

# ── per-IP budgets on the expensive entrances ─────────────────────────────────
# The whole ingest router shipped behind `require_scope("clone")` and nothing
# else, while the CHEAP single-stem clone on /v1/voices carried a demo budget.
# The asymmetry was backwards: one /scan is two ElevenLabs calls billed by
# duration plus five to eight Gemini calls plus a torch model load, and a
# scripted client with one valid key could run them back to back.
#
# `_admit` is not this. It bounds CONCURRENCY (how many scans at once) and
# releases the moment a scan finishes, so a client that simply waits its turn
# spends without limit. A budget bounds the RATE, per address, over a window.
#
# Sized for the SHIPPED shape of the traffic, exactly as app.py's budgets are:
# the studio relays server-side with the deployment's own key, so every visitor
# in the room arrives as ONE address until TTS_TRUST_PROXY is on. These are
# therefore limits for the whole room, not per human:
#
#   scan     12 per 10 minutes, burst 3 — a dozen people in a live demo each
#            uploading a recording, and a second attempt for the one whose
#            first take was bad. A scripted client cannot mint 100 cloud scans.
#   audition 40 per 10 minutes, burst 6 — auditions are local CPU synthesis and
#            the point of the room is to click freely between candidates;
#            `MAX_ACTIVE_AUDITIONS` already bounds how many run at once, so
#            this only has to stop a script from queueing them all day.
#
# Both env-tunable, because the right number is a property of the deployment.
def _budget_limit(env: str, default: int) -> int:
    try:
        return max(1, int(os.environ.get(env, "") or default))
    except ValueError:
        return default


SCAN_BUDGET = ratelimit.per_ip_budget(
    "ingest-scan", limit=_budget_limit("TTS_BUDGET_INGEST_SCAN", 12),
    window_s=600, burst=3, methods=("POST",))
AUDITION_BUDGET = ratelimit.per_ip_budget(
    "ingest-audition", limit=_budget_limit("TTS_BUDGET_INGEST_AUDITION", 40),
    window_s=600, burst=6, methods=("POST",))


# ── upload validation ─────────────────────────────────────────────────────────
MAX_UPLOAD_BYTES = 50 * 1024 * 1024
MIN_CLIP_SECONDS = 3.0
# Both ElevenLabs calls bill by duration, so the floor without a ceiling bounded
# nothing that costs money. See Settings.ingest_max_clip_seconds.
MAX_CLIP_SECONDS = SETTINGS.ingest_max_clip_seconds
_AUDIO_EXTS = {
    ".mp3", ".wav", ".wave", ".m4a", ".m4b", ".mp4", ".mov", ".ogg", ".oga",
    ".opus", ".flac", ".aac", ".webm", ".wma", ".aiff", ".aif", ".aifc",
    ".amr", ".3gp", ".mkv",
}
# Leading magic bytes that mark a container/codec we can hand to ffmpeg.
_AUDIO_MAGIC = (b"RIFF", b"ID3", b"OggS", b"fLaC", b"FORM", b"\x1aE\xdf\xa3")


def _looks_audio(data: bytes, filename: str) -> bool:
    """Extension whitelist first, then a header-byte sniff so a truthful upload
    without an extension still passes and a mislabelled blob is rejected."""
    if Path(filename or "").suffix.lower() in _AUDIO_EXTS:
        return True
    head = data[:16]
    if any(head.startswith(m) for m in _AUDIO_MAGIC):
        return True
    if len(head) >= 8 and head[4:8] == b"ftyp":   # mp4 / m4a / mov family
        return True
    if len(head) >= 2 and head[0] == 0xFF and (head[1] & 0xE0) == 0xE0:  # mp3 frame sync
        return True
    return False


def validate_upload_bytes(data: bytes, filename: str) -> str | None:
    """Return a human error string if the upload is unacceptable, else None."""
    if not data:
        return "empty upload — choose an audio file"
    if len(data) > MAX_UPLOAD_BYTES:
        return f"file too large — keep it under {MAX_UPLOAD_BYTES // (1024 * 1024)} MB"
    if not _looks_audio(data, filename):
        return "unsupported file type — upload an audio or video recording"
    return None


def probe_duration(path: Path) -> float | None:
    """Clip length via ffprobe; None when it can't be determined.

    None is not "fine, carry on": `check_duration` treats it as a REJECTION,
    because the duration gate is the only thing standing between an upload and
    two duration-billed cloud calls. A missing ffprobe binary (OSError) lands
    here too — the whole pipeline needs ffmpeg, so failing closed is honest."""
    try:
        r = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
            capture_output=True)
    except OSError:
        return None
    if r.returncode != 0:
        return None
    try:
        return float(r.stdout.decode(errors="ignore").strip())
    except ValueError:
        return None


def check_duration(dur: float | None) -> str | None:
    """Human error string when a clip's length disqualifies it, else None.

    Runs BEFORE any paid call. There used to be a floor and no ceiling, and an
    unreadable duration disabled even the floor: `dur is None` waved the upload
    straight through to Scribe."""
    if dur is None:
        return ("couldn't read this recording's length — re-export it as WAV or MP3 "
                "and try again")
    if dur < MIN_CLIP_SECONDS:
        return f"clip too short — record at least {MIN_CLIP_SECONDS:.0f} seconds of speech"
    if dur > MAX_CLIP_SECONDS:
        return (f"recording too long — keep it under {MAX_CLIP_SECONDS / 60:.0f} minutes "
                "(trim to the part you want cloned)")
    return None


def _spend_for(job_id: str) -> ingest.Spend:
    """This job's external-spend ledger, RESUMED rather than reset.

    `_SPEND` is per process, so a job rehydrated after a restart — or adopted
    from a dead replica — used to be handed a fresh `Spend` and, with it, a
    fresh retry/escalation budget against the same paid providers. The ledger
    is mirrored into `state.json` by `_persist`, so the budget a job has
    already spent survives the process that spent it.
    """
    with _LOCK:
        led = _SPEND.get(job_id)
        if led is None:
            led = _SPEND[job_id] = ingest.Spend()
            prior = (JOBS.get(job_id) or {}).get("spend")
            if isinstance(prior, dict):
                led.restore(prior)
                logger.info("ingest job %s: resumed a ledger of %d external "
                            "call(s), %d retr(ies)", job_id,
                            int(prior.get("total_calls") or 0),
                            int(prior.get("retries") or 0))
        return led




# ── state persistence (all callers hold _LOCK) ────────────────────────────────
def _persist(job: dict) -> None:
    """Mirror the job dict to `state.json`, safely against the OTHER replicas.

    Two things were wrong with the old write. The temp file had a FIXED name
    (`state.json.tmp`), so two processes writing the same job interleaved into
    one temp and `os.replace` could promote a mixed file — the exact hazard
    `atomicio._atomic_write`'s per-process temp name exists to remove. And the
    read-modify-write was guarded only by `_LOCK`, which serializes nothing
    between replicas; the cross-process mutex is `atomicio.file_lock`.

    Persisting is a MIRROR, so a failure here is logged and swallowed — losing
    the mirror costs a rehydrate, while raising would cost the caller's phase.
    """
    wd = Path(job["work_dir"])
    # Do NOT mkdir: a teardown (DELETE or GC) may have just rmtree'd this
    # workdir, and recreating it here resurrects an orphan directory that no
    # job owns. If the tree is gone the job is gone — there is nothing to
    # persist.
    if not wd.is_dir():
        return
    # Every state change is a heartbeat: GC ages a job from its last mutation,
    # so a job that is visibly progressing is never reaped mid-phase.
    job["touched"] = time.time()
    # The external-spend ledger rides along with the state it belongs to, so a
    # rehydrated job cannot mint itself a fresh budget of paid calls
    # (`_spend_for`). Cheap: a dict copy under the ledger's own lock.
    ledger = _SPEND.get(job.get("id"))
    if ledger is not None:
        job["spend"] = ledger.snapshot()
    try:
        with atomicio.file_lock(wd / ".state.lock"):
            atomicio.atomic_write_text(wd / "state.json", json.dumps(job))
    except (OSError, TimeoutError) as exc:
        # Losing the on-disk mirror means a restart can't rehydrate this job —
        # worth a log line rather than a bare pass.
        logger.warning("ingest job %s: state persist failed: %s",
                       job.get("id"), exc)


def _get_job(job_id: str) -> dict | None:
    """Locked lookup. Phase threads MUST use this: a bare JOBS[job_id] races a
    concurrent DELETE and dies with an uncaught KeyError on a bare thread."""
    with _LOCK:
        return JOBS.get(job_id)


def _update(job: dict, **fields) -> None:
    """Mutate + persist under the lock. No-op once the job is cancelled so a
    lagging worker thread can't resurrect a torn-down job."""
    with _LOCK:
        if job.get("cancel"):
            return
        job.update(fields)
        _persist(job)


def _mk_step(job: dict, key: str, state: str) -> None:
    with _LOCK:
        if job.get("cancel"):
            return
        for s in job["steps"]:
            if s["key"] == key:
                s["state"] = state
        job["step"] = key
        _persist(job)


def _partial(job: dict, d: dict) -> None:
    with _LOCK:
        if job.get("cancel"):
            return
        job["partial"].update(d)
        _persist(job)


# ── the commit journal ────────────────────────────────────────────────────────
# What a clone INTENDED and what it has actually REGISTERED, on disk, updated as
# it goes. `ingest.commit` registers each Voice through `voices.mutate_meta` the
# moment it is exported, so a process killed mid-clone leaves live rows behind
# and takes its in-memory `registered` list with it — `_rollback` never ran, and
# the next boot only relabelled the job. The journal is what survives, so the
# next boot can tell a HALF character (roll it back) from a whole one whose
# status flip was the only thing lost (mark it committed).
#
# Only the owning process writes it, so no cross-process mutex is needed — but
# it is written atomically, because a torn journal is a rollback that cannot
# name what it must undo.
_JOURNAL_NAME = "commit.json"


def _write_journal(work_dir: Path, doc: dict) -> None:
    if not work_dir.is_dir():
        return    # torn down under us; there is nothing left to reconcile
    try:
        atomicio.atomic_write_text(work_dir / _JOURNAL_NAME, json.dumps(doc))
    except OSError as exc:
        logger.warning("ingest: commit journal not written in %s: %s",
                       work_dir.name, exc)


def _read_journal(work_dir: Path) -> dict | None:
    try:
        doc = json.loads((work_dir / _JOURNAL_NAME).read_text("utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return doc if isinstance(doc, dict) else None


def _clear_journal(work_dir: Path) -> None:
    with contextlib.suppress(OSError):
        (work_dir / _JOURNAL_NAME).unlink(missing_ok=True)


def _journal_ids(journal: dict) -> list[str]:
    return [r.get("voice_id") for r in journal.get("registered") or []
            if isinstance(r, dict) and r.get("voice_id")]


def _reconcile(job: dict, work_dir: Path) -> None:
    """Decide what a job caught mid-flight by a restart actually left behind.

    Three outcomes, and the middle one is the whole point:

      * no journal (an analyze/label phase, or a commit that died before it
        registered anything) — nothing was created; the job is errored, as it
        always was;
      * a commit whose journal covers every emotion it intended, or that had
        written its `done` marker — the CLONE finished and only the status flip
        was lost, so the job becomes `committed` with the voices it made;
      * anything else — a PARTIAL character. Those voices are exactly the ones
        `_rollback` would have removed, so they are removed now and the job
        says so. This is the guarantee: no half-Character survives a restart
        unnoticed.

    A re-derivation is never rolled back, for the reason `_do_rederive`
    documents: it REPLACED voices the user already had, and removing the
    rebuilt one leaves the character with nothing for that emotion. It is
    reported instead, in the job and in its durable receipt.
    """
    journal = _read_journal(work_dir)
    if not journal:
        job["status"] = "error"
        job["error"] = "interrupted by restart"
        return

    made = [r for r in journal.get("registered") or [] if isinstance(r, dict)]
    if journal.get("kind") == "rederive":
        job["status"] = "error"
        job["error"] = ("interrupted by restart" if not made else
                        f"interrupted by restart after rebuilding {len(made)} "
                        "voice(s) — they were KEPT, because a rebuilt voice "
                        "replaced one that no longer exists")
        job["committed"] = made or None
        _record_rederive(job, "interrupted", made)
        _clear_journal(work_dir)
        return

    intended = [e for e in journal.get("intended") or []]
    done_emotions = {r.get("emotion") for r in made}
    complete = (journal.get("state") == "done"
                or (bool(intended) and set(intended) <= done_emotions))
    if complete:
        job["status"] = "committed"
        job["committed"] = made
        job["error"] = None
        job["partial"] = {"emotions_done": len(made),
                          "emotions_total": len(intended) or len(made),
                          "current": None}
        logger.warning("ingest job %s: the clone had finished when the process "
                       "stopped; marking it committed (%d voice(s))",
                       job.get("id"), len(made))
        _clear_journal(work_dir)
        return

    ids = _journal_ids(journal)
    job["status"] = "error"
    if not ids:
        job["error"] = "interrupted by restart"
    else:
        _rollback(str(job.get("id")), made, "was interrupted by a restart")
        job["error"] = (f"interrupted by a restart mid-clone — the {len(ids)} "
                        "voice(s) it had already created were removed")
    _clear_journal(work_dir)


# ── durable receipts ──────────────────────────────────────────────────────────
# What a job LEFT BEHIND, outliving the job itself.
#
# A cancelled re-derivation keeps every voice it had already rebuilt (see
# `_do_rederive`), but `cancel_job` popped the job and rmtree'd its workdir, so
# the list of replaced voices survived only in a server log while the API
# answered a bare {"status": "cancelled"}. The user was told nothing about a
# change that had already happened to their character. Receipts live OUTSIDE
# any job directory for exactly that reason, and `GET /v1/ingest/{job}` falls
# back to them, so the poller that was watching the job reads the outcome from
# the URL it already has.
_RECEIPTS_DIRNAME = ".receipts"
_RECEIPT_TTL_S = 60 * 60 * 24
_TERMINAL_OUTCOMES = ("completed", "cancelled", "failed", "interrupted")


def _receipts_dir() -> Path:
    return WORK_ROOT / _RECEIPTS_DIRNAME


def _receipt_path(job_id: str) -> Path:
    return _receipts_dir() / f"{job_id}.json"


def _read_receipt(job_id: str) -> dict | None:
    if not job_id or "/" in job_id or "\\" in job_id or job_id.startswith("."):
        return None
    try:
        doc = json.loads(_receipt_path(job_id).read_text("utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return doc if isinstance(doc, dict) else None


def _record_rederive(job: dict, outcome: str, made: list[dict]) -> None:
    """Write (or refine) the durable receipt for a re-derivation.

    Called as each voice is registered AND at every terminal path, including
    the cancelled one — where the job dict is already gone from JOBS and the
    workdir is already deleted. A terminal outcome is never downgraded back to
    "running" by a straggling progress write.
    """
    voices_made = [{"voice_id": v.get("voice_id"), "emotion": v.get("emotion"),
                    "replaced": v.get("replaced")}
                   for v in made if isinstance(v, dict)]
    prior = _read_receipt(str(job.get("id") or "")) or {}
    prior_out = ((prior.get("rederive") or {}).get("outcome") or "")
    if outcome == "running" and prior_out in _TERMINAL_OUTCOMES:
        outcome = prior_out
    doc = {k: job.get(k) for k in _PUBLIC_KEYS if k != "rederive"}
    doc["rederive"] = {
        "outcome": outcome,
        "character_id": job.get("character_id"),
        "voices": voices_made,
        # The one fact a cancelled rebuild owes its user: these are LIVE.
        "kept": True,
        "at": time.time(),
    }
    try:
        _receipts_dir().mkdir(parents=True, exist_ok=True)
        atomicio.atomic_write_text(_receipt_path(str(job.get("id"))),
                                   json.dumps(doc))
    except OSError as exc:
        logger.warning("ingest job %s: rederive receipt not written: %s",
                       job.get("id"), exc)


# ── rehydrate + GC ────────────────────────────────────────────────────────────
def _rehydrate() -> None:
    """Reload the jobs THIS process owns from disk on startup.

    Ownership is the whole point of the claim (see "ownership across
    replicas"): a job directory whose owner is still beating belongs to that
    replica, and loading it here would give one job two owners, two sets of
    phase threads and two GC verdicts. A job we cannot claim is skipped
    entirely — not loaded read-only — because every read path in this module
    (`_get_job`, `get_job`, the preview routes) is also a mutation path's
    neighbour, and "visible but not writable" is a distinction this store has
    no way to enforce.

    Jobs caught mid-flight (running) by the restart become errored; awaiting/
    finished jobs stay usable until they expire.
    """
    if not WORK_ROOT.is_dir():
        return
    for d in sorted(WORK_ROOT.iterdir()):
        sf = d / "state.json"
        if not d.is_dir() or d.name in _RESERVED_DIRS or not sf.is_file():
            continue
        try:
            job = json.loads(sf.read_text("utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if not isinstance(job, dict) or "id" not in job:
            continue
        if not _claim(d):
            logger.info("ingest job %s belongs to a live replica; not rehydrated",
                        job.get("id"))
            continue
        job["cancel"] = False
        if job.get("status") in ("running", "committing"):
            # Not just a relabel: whatever this job registered before the
            # process stopped is undone, or finished, from its journal.
            _reconcile(job, d)
            _persist(job)  # locked + atomic, same as every other writer
        JOBS[job["id"]] = job


def _is_expired(job: dict, now: float) -> bool:
    """Age a job from its last state mutation, against a TTL chosen by STATUS.

    Age alone reaped jobs that were mid-flight and healthy (a long cloud scan
    hit the 30-minute mark and had its workdir deleted under the running
    thread). An actively-working job now only expires on the far longer wedged
    threshold, and only if it has stopped reporting progress."""
    age = now - max(job.get("touched", 0), job.get("created", 0))
    return age > (_RUNNING_TTL if job.get("status") in ACTIVE_STATUSES else _TTL)


def _active_count() -> int:
    """Jobs currently occupying CPU / external spend. Caller holds _LOCK."""
    return sum(1 for v in JOBS.values() if v.get("status") in ACTIVE_STATUSES)


def _admit() -> None:
    """Admission gate for every phase that starts real work. 429 rather than
    queue: the client is a poller that can retry, and silently queueing an
    upload behind a 10-minute scan reads as a hang.

    `Retry-After` is set because a 429 without one makes the CLIENT invent the
    wait: the studio's retry countdown has to fall back to its own backoff and
    say so, rather than telling the user what this service actually asked for.
    The engine's backpressure paths (service/app.py) have always sent it; this
    one did not, so the two 429s in the product disagreed about whether a
    caller is told when to come back. A scan is minutes long, so the hint is
    deliberately coarse — it says "not instantly", not a real ETA, which is
    the honest amount of information available here.

    The COUNT is this process's, because a job's phase threads live in the
    process that OWNS it — so the configured budget is divided across the
    replicas and the refusal states the pool-wide number (`admission_shape`).
    A 429 quoting `MAX_ACTIVE_JOBS` on a 4-replica box named a limit the box
    never applied.
    """
    per, pool, replicas = admission_shape(MAX_ACTIVE_JOBS)
    with _LOCK:
        active = _active_count()
    if active >= per:
        raise HTTPException(
            429, f"{active} recording(s) are already being processed"
                 + (f" by this replica (the box runs {replicas} of them and "
                    f"processes at most {pool} recordings at once)"
                    if replicas > 1 else "")
                 + " — try again in a moment",
            headers={"Retry-After": str(ADMISSION_RETRY_AFTER_S)})


def _gc_once() -> None:
    now = time.time()
    with _LOCK:
        for jid in [j for j, v in JOBS.items() if _is_expired(v, now)]:
            # Set the cancel flag BEFORE deleting anything — same teardown
            # protocol as cancel_job. Without it a phase thread that outlived
            # the TTL keeps working against a deleted workdir (and _persist
            # used to recreate the directory behind GC's back).
            JOBS[jid]["cancel"] = True
            shutil.rmtree(JOBS[jid]["work_dir"], ignore_errors=True)
            forget_metrics(JOBS[jid]["work_dir"])
            JOBS.pop(jid, None)
            _SPEND.pop(jid, None)
        live = {v["work_dir"] for v in JOBS.values()}
    # Scratch audition artefacts inside a LIVE job's workdir. `export_stems
    # .audition` removes its own scratch dir in a `finally`, so anything left
    # here outlived a crash — log it rather than tidy up in silence.
    for wd in live:
        try:
            leaked = export_stems.gc_scratch(wd)
        except Exception as exc:  # noqa: BLE001 - the sweep must never break GC
            logger.warning("audition scratch sweep failed for %s: %s", wd, exc)
            continue
        if leaked:
            logger.warning("swept %d leaked audition scratch artefact(s) in %s: %s",
                           len(leaked), wd, leaked)
    # Orphan workdirs with no live job (e.g. left by a crash) age out too — but
    # ONLY if no live replica owns them. This sweep used to delete a sibling
    # process's job directory out from under its running phase thread purely
    # because this process had never heard of the job (deploy/README.md
    # documented that as unfixed). A directory owned by a beating process is
    # somebody's; a directory owned by nobody, or by an owner whose beat
    # stopped, is ours to reap.
    if WORK_ROOT.is_dir():
        for d in WORK_ROOT.iterdir():
            if not d.is_dir() or str(d) in live or d.name in _RESERVED_DIRS:
                continue
            owner = _owner_of(d)
            if owner and owner != OWNER and _owner_alive(owner):
                continue
            try:
                if now - d.stat().st_mtime > _TTL:
                    shutil.rmtree(d, ignore_errors=True)
            except OSError:
                pass
    # Receipts outlive their jobs, but not forever: they are a day's worth of
    # "what happened to the rebuild I cancelled", not an audit log.
    if _receipts_dir().is_dir():
        for r in _receipts_dir().iterdir():
            try:
                if now - r.stat().st_mtime > _RECEIPT_TTL_S:
                    r.unlink(missing_ok=True)
            except OSError:
                pass
    # Heartbeat files of processes that never came back.
    if _owners_dir().is_dir():
        for b in _owners_dir().iterdir():
            try:
                if b.name != _beat_path().name and now - b.stat().st_mtime > _BEAT_TTL_S:
                    b.unlink(missing_ok=True)
            except OSError:
                pass


def _gc_loop(stop: threading.Event | None = None) -> None:
    """Beat, sweep, repeat.

    Two clocks, deliberately: the OWNERSHIP heartbeat has to be much faster
    than the sweep (a replica that only says "still here" every five minutes
    would have to be presumed dead for five minutes before anyone could adopt
    its jobs), while a full sweep every fifteen seconds would be pointless
    stat() traffic on a small Arm box.
    """
    waiter = stop or threading.Event()
    last_sweep: float | None = None
    while True:
        try:
            _beat()
            if last_sweep is None or time.monotonic() - last_sweep >= _GC_INTERVAL:
                last_sweep = time.monotonic()
                # Sweep FIRST: the most valuable sweep is the one right after a
                # restart (orphan workdirs left by the previous process), and
                # sleeping first stranded those for a full interval.
                _gc_once()
        except Exception as exc:  # noqa: BLE001 - the loop must never die
            logger.warning("ingest GC sweep failed: %s", exc)
        if waiter.wait(_BEAT_INTERVAL):
            return


# ── background phases ─────────────────────────────────────────────────────────
def _spawn(target: Callable, args: tuple, name: str) -> threading.Thread:
    """Start a phase thread AND remember it, so shutdown can wait for it.

    Still a daemon: a wedged ffmpeg must not hold the process open past the
    orchestrator's stop grace. The difference is that `stop_background` now
    gets a bounded chance to let it finish first, and says in the log what it
    could not wait out.
    """
    t = threading.Thread(target=target, args=args, daemon=True, name=name)
    with _LOCK:
        _PHASES[:] = [p for p in _PHASES if p.is_alive()]
        if isinstance(t, _REAL_THREAD):
            _PHASES.append(t)
    t.start()
    return t


def _canceller(job: dict) -> Callable[[], bool]:
    """The one cancellation predicate handed to the pipeline. Reads the flag
    under _LOCK — cancel_job/GC set it on this same dict after popping the job
    from JOBS, so the thread keeps seeing it."""
    def cancelled() -> bool:
        with _LOCK:
            return bool(job.get("cancel"))
    return cancelled


def _fail(job: dict, action: str, exc: BaseException) -> None:
    """Terminal failure of a background phase, told honestly but without
    internals. Phase exceptions routinely wrap ffmpeg/pocket-tts stderr and
    absolute paths; `errors.sanitize_detail` logs the raw cause against a
    request id and leaves the client the id (only `errors.UserFacing` messages,
    authored for humans, pass through).

    The user gets a sanitized sentence; the OPERATOR gets the exception. These
    phases run on their own threads and catch everything, so nothing here ever
    reaches an excepthook — before this hand-off existed, a phase that died on
    provider call 31 of 40 left one log line and no way to know afterwards
    whether it had happened once or forty times. The job's spend ledger rides
    along, because "failed after 47 calls and 12 retries" and "failed on the
    first call" are different bugs."""
    job_id = job.get("id") or ""
    ledger = _SPEND.get(job_id)
    observability.capture_ingest_failure(
        job_id, job.get("mode") or "", action, exc,
        ledger.snapshot() if ledger is not None else None)
    _update(job, status="error", error=errors.sanitize_detail(action, exc))


def _analyze(job_id: str, audio: Path) -> None:
    job = _get_job(job_id)
    if job is None:  # cancelled between Thread.start() and here
        audio.unlink(missing_ok=True)
        return
    cancelled = _canceller(job)
    sovereign = job["mode"] == "sovereign"
    # This thread belongs to one job for its whole life; tag it so anything
    # reported from here arrives already attributed.
    observability.bind_ingest_job(job_id, job["mode"])
    try:
        if sovereign:
            # Local-only phase: no paid calls, no fan-out. Cancellation is
            # honoured at its edges (the expensive fan-out in BOTH modes is the
            # labelling phase, which polls per segment).
            if cancelled():
                raise ingest.Cancelled()
            res = ingest.sovereign_analyze(
                audio, Path(job["work_dir"]),
                progress=lambda k, s: _mk_step(job, k, s),
                partial=lambda d: _partial(job, d))
            if cancelled():
                raise ingest.Cancelled()
        else:
            res = ingest.analyze(
                audio, Path(job["work_dir"]),
                progress=lambda k, s: _mk_step(job, k, s),
                partial=lambda d: _partial(job, d),
                should_cancel=cancelled, spend=_spend_for(job_id))
        if not res.get("speakers"):
            raise errors.UserFacing("no speech detected in the clip")
        # What this phase actually spent — zeros in sovereign mode, which is
        # itself worth showing (the audio never left the machine).
        _partial(job, {"spend": _spend_for(job_id).snapshot()})
        # `note`, `limits` and `detection` are what the analyze phase LEARNED
        # about this recording (sovereign only, today): the mode's own limits,
        # the speech-detection outcome and the levels it measured. They used to
        # be dropped here, so the studio hand-copied the limits constant and
        # never saw an outcome at all. Absent in cloud mode → None, not a key
        # the client has to distinguish from "not computed yet".
        _update(job, speakers=res["speakers"], duration=res["duration"],
                note=res.get("note"), limits=res.get("limits"),
                detection=res.get("detection"),
                status="awaiting_speaker")
    except ingest.Cancelled:
        # Not a failure: the job is already torn down and `_update` would
        # no-op anyway. Say so in the log so a vanished job is explicable.
        logger.info("ingest job %s: analyze abandoned (cancelled)", job_id)
    except Exception as exc:  # noqa: BLE001
        _fail(job, "recording analysis", exc)
    finally:
        audio.unlink(missing_ok=True)


def _label(job_id: str, target: str) -> None:
    job = _get_job(job_id)
    if job is None:  # cancelled between Thread.start() and here
        return
    observability.bind_ingest_job(job_id, job["mode"])
    try:
        res = ingest.label_and_stem(
            Path(job["work_dir"]), target,
            progress=lambda k, s: _mk_step(job, k, s),
            partial=lambda d: _partial(job, d),
            mode=job["mode"],
            should_cancel=_canceller(job), spend=_spend_for(job_id))
        # Candidate stems for the Audition Room. Advisory by construction: a
        # failure here costs the user the drill-down, never the scan, and the
        # reason is published rather than swallowed (`recipes.unavailable`).
        plan: dict[str, dict[str, list[int]]] = {}
        why: str | None = None
        try:
            plan, why = build_recipes(Path(job["work_dir"]), res)
        except Exception as exc:  # noqa: BLE001 - never fail a scan over recipes
            logger.warning("ingest job %s: recipes skipped: %s", job_id, exc)
            why = "candidate stems could not be built for this scan"
        # What each stem is spliced FROM, published with the ledger. The studio
        # needs it before anything is re-cast (a row expands into its segments
        # read-only first), and it must be the pipeline's own answer: the
        # baseline's segments are not "the neutral ones" — plan_baseline may have
        # topped it up — so a client deriving this from the labels would draw a
        # stem the backend never built.
        casting: dict | None = None
        try:
            _rows, proposed, why_cast = _board(Path(job["work_dir"]), res)
            casting = {"assignments": proposed, "edited": [], "unavailable": why_cast}
        except Exception as exc:  # noqa: BLE001 - never fail a scan over the board
            logger.warning("ingest job %s: casting board unavailable: %s", job_id, exc)
            casting = {"assignments": {}, "edited": [],
                       "unavailable": "the segments of this scan could not be listed"}
        _update(job, result={"duration": job.get("duration", 0),
                             "speakers": [s["id"] for s in job.get("speakers", [])],
                             "mode": job["mode"], **res},
                recipe_plan=plan, casting=casting,
                recipes={"applied": {}, "skipped": [], "unavailable": why},
                status="done")
        # The job is over; publish what it spent. `Spend` has counted every
        # ElevenLabs and Gemini call the whole way through — this is that same
        # snapshot, read once more for the operator's pipe rather than the
        # client's. Nothing is recomputed here (see observability.spend_context).
        # `_SPEND.get`, not `_spend_for`: reporting must never resurrect a
        # ledger the job's own teardown has already dropped.
        ledger = _SPEND.get(job_id)
        observability.record_ingest_spend(
            job_id, job["mode"], "done",
            ledger.snapshot() if ledger is not None else None)
    except ingest.Cancelled:
        logger.info("ingest job %s: labelling abandoned (cancelled)", job_id)
    except Exception as exc:  # noqa: BLE001
        _fail(job, "emotion labelling", exc)


def _commit_progress(job: dict, done: int, total: int, current: str | None) -> None:
    with _LOCK:
        if job.get("cancel"):
            return
        job["partial"] = {"emotions_done": done, "emotions_total": total, "current": current}
        _persist(job)


def _rollback(job_id: str, created: list[dict], why: str) -> None:
    """Undo a half-finished clone. ONE rollback for both abandonment paths.

    `ingest.commit` registers each Voice as it goes, and tearing down the
    WORKDIR does not touch VOICES_DIR — so every emotion that finished before a
    cancel OR before an exception is a live, registered Voice: exactly the
    partial Character the user never agreed to. Only the ids this commit
    created are removed, so a cancelled *extend* keeps the character's
    pre-existing Voices. Teardown must not raise: a failed rollback is logged
    loudly (the voices really are still live) and the job still ends terminal.
    """
    ids = [v.get("voice_id") for v in created
           if isinstance(v, dict) and v.get("voice_id")]
    if not ids:
        return
    try:
        removed = voices.remove_voices(ids)
        logger.warning("ingest job %s %s mid-clone; rolled back %d/%d "
                       "voice(s): %s", job_id, why, len(removed), len(ids), removed)
    except Exception as exc:  # noqa: BLE001 - teardown must not raise
        logger.error(
            "ingest job %s %s but ROLLBACK FAILED — these voices remain "
            "registered and must be removed by hand: %s (%s)",
            job_id, why, ids, exc)


def _apply_recipes(job: dict, emotions: list[str], chosen: dict[str, str]) -> None:
    """Re-splice each chosen emotion's stem to the recipe the user auditioned.

    `ingest.commit` clones `stem_{emotion}.wav`, so committing a choice means
    making that file BE the chosen splice — the recipe wavs were written next to
    it at scan time, so this is a copy, not a re-render, and the audition the user
    heard is byte-identical to what gets cloned.

    Every outcome is named on the job (`recipes.applied` / `recipes.skipped`): a
    chosen recipe whose audio has since been swept, or which was never offered
    for that emotion, must not silently clone the default and let the user
    believe their pick shipped.
    """
    wd = Path(job["work_dir"])
    plan = job.get("recipe_plan") or {}
    applied: dict[str, str] = {}
    skipped: list[dict] = []
    for emo in emotions:
        rid = chosen.get(emo)
        if not rid or rid == RECIPE_FULL:
            continue
        if rid not in (plan.get(emo) or {}):
            skipped.append({"emotion": emo, "recipe": rid,
                            "why": "that recipe was not offered for this emotion"})
            continue
        src = wd / f"stem_{emo}__{rid}.wav"
        dst = wd / f"stem_{emo}.wav"
        try:
            shutil.copyfile(src, dst)
        except OSError as exc:
            logger.warning("ingest job %s: recipe %s/%s not applied: %s",
                           job.get("id"), emo, rid, exc)
            skipped.append({"emotion": emo, "recipe": rid,
                            "why": "the recipe audio is no longer available"})
            continue
        applied[emo] = rid
    with _LOCK:
        if job.get("cancel"):
            return
        cur = job.get("recipes") or {}
        job["recipes"] = {"applied": applied, "skipped": skipped,
                          "unavailable": cur.get("unavailable")}
        _persist(job)


def _capture_corpus(job: dict, character_id: str, statement: str,
                    created: list[dict]) -> None:
    """Copy this job's durable facts into the character's corpus, after a commit
    that really created Voices.

    Runs LAST and reports on the job (`corpus`), never raises and never changes
    the commit's outcome: the clone is already done and registered, so a corpus
    that could not be written is a named degradation, not a failed clone. The
    workdir is untouched — GC still owns it — because the corpus is a COPY.
    """
    outcome: dict
    if not created:
        outcome = {"requested": True, "captured": False,
                   "reason": "this commit created no voices, so there is "
                             "nothing whose source audio would be kept"}
    else:
        res = ingest.capture_corpus(
            Path(job["work_dir"]), character_id, job.get("result") or {},
            clip_sha256=job.get("clip_sha256"), consent=statement,
            mode=job.get("mode") or "cloud", levels=job.get("detection"),
            committed=created)
        outcome = {"requested": True, **res}
    with _LOCK:
        if job.get("cancel"):
            return
        job["corpus"] = outcome
        _persist(job)


def _do_commit(job_id: str, character: str, emotions: list[str], character_id: str | None,
               statement: str, recipes: dict[str, str] | None = None,
               corpus: bool = False) -> None:
    job = _get_job(job_id)
    if job is None:  # cancelled between Thread.start() and here
        return
    if recipes:
        # BEFORE the clone: the stems must be what the user chose by the time the
        # exporter reads them. Under _STEM_LOCK, because this WRITES the stem
        # files — it is a re-splice by another name, and it must not interleave
        # with one from the casting board.
        try:
            with _STEM_LOCK:
                _apply_recipes(job, emotions, recipes)
        except Exception as exc:  # noqa: BLE001 - a commit must not die over this
            logger.warning("ingest job %s: recipe application failed: %s", job_id, exc)
    total = len(emotions)
    cancelled = _canceller(job)

    # Ledger of what was actually REGISTERED, kept as it happens: on the
    # exception path there is no return value to inspect, and the voices
    # already written are precisely what has to be undone.
    registered: list[dict] = []
    # ...and its durable twin, for the exception this process does not get to
    # handle: SIGTERM. See "the commit journal".
    wd = Path(job["work_dir"])
    journal = {"kind": "commit", "state": "running", "job_id": job_id,
               "character": character, "character_id": character_id,
               "intended": list(emotions), "registered": [],
               "started": time.time()}
    _write_journal(wd, journal)

    def _note(v: dict) -> None:
        registered.append(v)
        journal["registered"] = [
            {"voice_id": r.get("voice_id"), "emotion": r.get("emotion")}
            for r in registered if isinstance(r, dict)]
        _write_journal(wd, journal)

    failure: BaseException | None = None
    try:
        created = ingest.commit(
            Path(job["work_dir"]), character, emotions, character_id,
            consent=statement, clip_sha256=job.get("clip_sha256"),
            progress=lambda done, cur: _commit_progress(job, done, total, cur),
            should_cancel=cancelled, on_voice=_note)
    except Exception as exc:  # noqa: BLE001
        created, failure = registered, exc

    with _LOCK:
        was_cancelled = bool(job.get("cancel"))
        if not was_cancelled and failure is None:
            # The `done` marker goes down BEFORE the status flip: a crash in
            # between must be read as "the clone finished", which it did.
            journal["state"] = "done"
            _write_journal(wd, journal)
            job["committed"] = created
            job["partial"] = {"emotions_done": total, "emotions_total": total,
                              "current": None}
            job["status"] = "committed"
            _persist(job)

    if failure is not None:
        # Reach a terminal state FIRST (a poller must never hang on a failed
        # commit), then undo. `_update` no-ops if the job was also cancelled.
        _fail(job, "voice cloning", failure)
        _rollback(job_id, registered, "failed")
        _clear_journal(wd)
    elif was_cancelled:
        _rollback(job_id, created, "cancelled")
        _clear_journal(wd)
    else:
        # Handled in full; nothing is left for a restart to reconcile.
        _clear_journal(wd)
    if failure is None and not was_cancelled and corpus:
        # ONLY on the clean path: a rolled-back commit's voices no longer exist,
        # and keeping the audio that made them would be retention with nothing
        # to justify it.
        cid = character_id or voices._slug(character)
        try:
            _capture_corpus(job, cid, statement, created)
        except Exception as exc:  # noqa: BLE001 - never turn a clone into an error
            logger.warning("ingest job %s: corpus capture failed: %s", job_id, exc)


def _do_rederive(job_id: str, character_id: str, emotions: list[str] | None) -> None:
    """Rebuild + re-export one character's voices from its corpus, as a phase.

    Same shape as `_do_commit`, for the same reasons: it loads the TTS model in
    a child process (minutes on a CPU box), it registers Voices one at a time,
    and a caller must be able to cancel it and poll it.

    It does NOT roll back, and that is the deliberate difference from a commit.
    A commit's rollback removes voices the user never had; a re-derivation
    REPLACES voices they already had, and the embedding it replaced is gone by
    the time the row is swapped. Removing the rebuilt voice would therefore
    leave the character with no voice for that emotion at all — strictly worse
    than the rebuilt one it just made. So an abandoned rebuild keeps every
    emotion it finished, and says which ones those were.
    """
    job = _get_job(job_id)
    if job is None:
        return
    registered: list[dict] = []
    started = {"clone": False}
    wd = Path(job["work_dir"])
    # The journal says "a rebuild was in flight here" so a restart reports it
    # rather than rolling it back; the RECEIPT is what the user can still read
    # after the job (and its workdir) are gone.
    journal = {"kind": "rederive", "state": "running", "job_id": job_id,
               "character_id": character_id, "intended": list(emotions or []),
               "registered": [], "started": time.time()}
    _write_journal(wd, journal)
    _record_rederive(job, "running", registered)

    def _note(v: dict) -> None:
        registered.append(v)
        journal["registered"] = [
            {"voice_id": r.get("voice_id"), "emotion": r.get("emotion")}
            for r in registered if isinstance(r, dict)]
        _write_journal(wd, journal)
        # Written per voice, on purpose: a cancel can land at any point, and
        # the receipt must already name what is live when it does.
        _record_rederive(job, "running", registered)

    def _progress(done: int, current: str | None) -> None:
        if not started["clone"]:
            started["clone"] = True
            _mk_step(job, "stem", "done")
            _mk_step(job, "clone", "active")
        with _LOCK:
            if job.get("cancel"):
                return
            job["partial"] = {**(job.get("partial") or {}),
                              "emotions_done": done, "current": current}
            _persist(job)

    failure: BaseException | None = None
    res: dict = {}
    try:
        _mk_step(job, "stem", "active")
        res = ingest.rederive(
            character_id, Path(job["work_dir"]), emotions,
            progress=_progress, should_cancel=_canceller(job),
            on_voice=_note)
    except ingest.Cancelled:
        logger.info("ingest job %s: rederive abandoned (cancelled)", job_id)
    except Exception as exc:  # noqa: BLE001
        failure = exc

    with _LOCK:
        was_cancelled = bool(job.get("cancel"))
        if not was_cancelled and failure is None:
            _mk_step(job, "clone", "done")
            job["committed"] = res.get("created") or []
            job["result"] = {"mode": "rederive", **res}
            job["partial"] = {"emotions_done": len(res.get("created") or []),
                              "emotions_total": len(res.get("stems") or []),
                              "current": None}
            job["status"] = "committed"
            _persist(job)

    _clear_journal(wd)
    if failure is not None or was_cancelled:
        done = [v.get("voice_id") for v in registered if isinstance(v, dict)]
        logger.warning(
            "ingest job %s: rederive %s after rebuilding %d voice(s) — they are "
            "KEPT (see _do_rederive): %s", job_id,
            "failed" if failure is not None else "was cancelled", len(done), done)
    # The receipt is written on EVERY terminal path, cancelled included. The
    # cancelled one is the reason it exists: `cancel_job` has already popped
    # the job and deleted its workdir, and the replaced voices are live.
    _record_rederive(job, "failed" if failure is not None
                     else "cancelled" if was_cancelled else "completed",
                     registered if (failure is not None or was_cancelled)
                     else (res.get("created") or registered))
    if failure is not None:
        _fail(job, "voice re-derivation", failure)


# ── endpoints ─────────────────────────────────────────────────────────────────
@router.post(f"{INGEST}/scan", dependencies=[Depends(SCAN_BUDGET)])
def start_scan(file: UploadFile = File(...), mode: str = Form("auto"),
               corpus: bool = Form(False)) -> dict:
    # NOT async: the prologue writes up to 50 MB, runs ffprobe and hashes the
    # clip before handing off to the phase thread — all of that belongs on the
    # threadpool, not the event loop (every other route in this file is `def`).
    #
    # `corpus` (default FALSE) is the whole opt-in: it asks this box to KEEP the
    # audio and labels this job produces once the clone succeeds. It changes
    # nothing about the scan itself, and the commit can still override it.
    if mode not in SCAN_MODES:
        raise HTTPException(400, "mode must be auto, cloud or sovereign")
    _admit()  # before the 50 MB read: a rejected upload should cost nothing
    data = file.file.read()  # sync read — we're on the threadpool
    err = validate_upload_bytes(data, file.filename or "")
    if err:
        raise HTTPException(400, err)

    resolved = ingest.resolve_mode(mode)
    job_id = uuid.uuid4().hex[:12]
    work_dir = WORK_ROOT / job_id
    work_dir.mkdir(parents=True, exist_ok=True)
    _write_owner(work_dir)   # this process runs its phases; no sibling may adopt it
    safe_name = Path(file.filename or "upload").name
    src = work_dir / f"src-{safe_name}"
    src.write_bytes(data)

    bad = check_duration(probe_duration(src))
    if bad:
        shutil.rmtree(work_dir, ignore_errors=True)
        raise HTTPException(400, bad)

    job = {
        "id": job_id, "status": "running", "step": None, "mode": resolved,
        "steps": [{**s, "state": "pending"} for s in STEPS_BY_MODE[resolved]],
        "partial": {}, "speakers": None, "duration": 0, "result": None, "error": None,
        "note": None, "limits": None, "detection": None,
        "work_dir": str(work_dir), "created": time.time(),
        "clip_sha256": hashlib.sha256(data).hexdigest(), "cancel": False,
        "committed": None,
        # Audition Room state: `recipes` is public (choices + named outcomes),
        # `recipe_plan` is the server-side index map behind them.
        "recipes": None, "recipe_plan": {},
        # Casting Board state. None until the user re-casts something: absent
        # means "the stems are exactly what the pipeline proposed", which is a
        # different fact from an assignment map that happens to match it.
        "casting": None,
        # Corpus state. `requested` is what the caller asked for at upload time
        # (the commit may still change its mind); everything else is filled in
        # after a successful commit and always NAMES the outcome, including
        # "not requested" — a silent absence would be indistinguishable from a
        # capture that failed.
        "corpus": {"requested": bool(corpus), "captured": False,
                   "reason": None if corpus else "corpus capture was not requested"}}
    with _LOCK:
        JOBS[job_id] = job
        _persist(job)
    _spawn(_analyze, (job_id, src), f"ingest-analyze-{job_id}")
    return {"job_id": job_id, "mode": resolved}


_PUBLIC_KEYS = ("id", "status", "step", "steps", "partial", "speakers",
                "duration", "result", "error", "mode", "committed",
                # What happened to the user's recipe choices at commit, plus the
                # reason candidate stems are absent when they are. `recipe_plan`
                # (the segment indices behind each recipe) is deliberately NOT
                # here: a client names a recipe, it never selects audio.
                "recipes",
                # The Casting Board's state: which segments each stem is
                # currently spliced from and which emotions the user has
                # re-cast. Published (unlike `recipe_plan`) because it IS the
                # caller's own selection echoed back — a reload, or a second
                # tab, must not show a ledger whose numbers no longer match the
                # audio on disk.
                "casting",
                # Whether this job's audio was kept, and — always — why not.
                "corpus",
                # A re-derivation's outcome: which voices it replaced, and that
                # they are KEPT. Present on the job while it runs and on the
                # durable receipt after it is gone (see "durable receipts").
                "rederive",
                # What analyze learned about THIS recording. A key the job dict
                # holds but this tuple omits is computed and then thrown away —
                # that is exactly what happened to these three.
                "note", "limits", "detection")


@router.get(f"{INGEST}/modes")
def modes() -> dict:
    """What each ingest mode does to a recording, from the backend's own
    constants — and which one `auto` resolves to right now.

    Declared BEFORE `/{job_id}` on purpose: the dynamic route would otherwise
    swallow this path and answer "job expired". The studio used to hand-write
    sovereign's limits into its upload panel, one copy per side of the API with
    nothing to catch a drift; `resolve_mode` is served with them so a user whose
    `auto` will resolve to sovereign is told before they upload, not after."""
    return {
        "resolved_auto": ingest.resolve_mode("auto"),
        "sovereign": {"limits": list(ingest.SOVEREIGN_LIMITS),
                      "note": ingest.sovereign_note()},
    }


@router.get(INGEST + "/{job_id}")
def get_job(job_id: str):
    with _LOCK:
        job = JOBS.get(job_id)
        if job:
            return {k: job.get(k) for k in _PUBLIC_KEYS}
    # The job is gone — but a re-derivation that was cancelled or interrupted
    # CHANGED the user's character before it stopped, and that outcome outlives
    # the job (see "durable receipts"). A 404 here used to be the only answer,
    # so the one fact worth keeping was the one fact the API never told.
    receipt = _read_receipt(job_id)
    if receipt:
        return receipt
    return job_expired()


@router.get(INGEST + "/{job_id}/speaker-preview/{sid}")
def speaker_preview(job_id: str, sid: str):
    job = _get_job(job_id)
    if not job:
        return job_expired()
    p = Path(job["work_dir"]) / f"speaker_{sid}.wav"
    if not p.is_file():
        raise HTTPException(404, "preview not found")
    return FileResponse(str(p), media_type="audio/wav")


class SpeakerReq(BaseModel):
    speaker_id: str


@router.post(INGEST + "/{job_id}/speaker")
def choose_speaker(job_id: str, req: SpeakerReq) -> dict:
    _admit()  # labelling is the biggest fan-out in the pipeline
    with _LOCK:
        job = JOBS.get(job_id)
        if not job:
            return job_expired()
        if job["status"] != "awaiting_speaker":
            raise HTTPException(409, "not awaiting speaker")
        job["status"] = "running"
        job["partial"] = {}
        _persist(job)
    _spawn(_label, (job_id, req.speaker_id), f"ingest-label-{job_id}")
    return {"status": "running"}


class AuditionReq(BaseModel):
    emotion: str
    text: str = ""
    recipe: str | None = None


@router.post(INGEST + "/{job_id}/audition",
             dependencies=[Depends(AUDITION_BUDGET)])
def audition(job_id: str, req: AuditionReq):
    """Hear a candidate stem AS A VOICE, before anything is committed.

    The one thing this flow could never do: `/preview/{emotion}` plays the
    speaker's own spliced audio, so the question the product exists to answer
    ("does the clone sound like me?") was only answerable after an irreversible
    commit had written real Voices into the roster. This synthesizes `text` with a
    throwaway clone of the chosen candidate stem and returns the wav.

    What makes it safe to call freely:
      * it holds an AUDITION slot, not a job slot (`_audition_slot`), so it
        neither blocks nor is blocked by scans and commits;
      * the scratch voice lives and dies inside this job's workdir under the
        `_audition_` prefix — never `VOICES_DIR`, never `meta.json`, never a
        slot-holder check (`export_stems.audition`);
      * there is no length gate: a stem too short to COMMIT can still be heard,
        which is the point.

    Meta comes back on `X-Audition-*` headers (emotion, recipe, seconds, source
    seconds) so the studio can label what is playing without a second round trip.
    """
    try:
        emotion = normalize_emotion(req.emotion)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    recipe = req.recipe or RECIPE_FULL
    if recipe not in RECIPE_ORDER:
        raise HTTPException(400, "unknown recipe")
    text = (req.text or "").strip() or DEFAULT_AUDITION_TEXT
    if len(text) > MAX_AUDITION_TEXT:
        raise HTTPException(
            400, f"audition line too long — keep it under {MAX_AUDITION_TEXT} characters")

    job = _get_job(job_id)
    if not job:
        return job_expired()
    if job.get("status") != "done":
        raise HTTPException(409, "auditions need a finished scan")
    wd = Path(job["work_dir"])
    if recipe == RECIPE_FULL:
        src = wd / f"stem_{emotion}.wav"
    else:
        if recipe not in ((job.get("recipe_plan") or {}).get(emotion) or {}):
            raise HTTPException(404, "that recipe was not offered for this emotion")
        src = wd / f"stem_{emotion}__{recipe}.wav"
    if not src.is_file():
        raise HTTPException(404, "no audio for that emotion")

    with _audition_slot():
        res = export_stems.audition(
            src=src, text=text,
            language=SETTINGS.language, quantize=SETTINGS.quantize,
            scratch_dir=wd / f"{export_stems.AUDITION_PREFIX}{uuid.uuid4().hex[:8]}",
            timeout=AUDITION_TIMEOUT_S)
    if not res.get("ok") or not res.get("audio"):
        # Named, sanitized: the child's error can carry paths and torch noise.
        raise errors.sanitized_500("audition", res.get("error") or "audition failed")
    return Response(
        content=res["audio"], media_type="audio/wav",
        headers={
            "X-Audition-Emotion": emotion,
            "X-Audition-Recipe": recipe,
            "X-Audition-Seconds": str(res.get("seconds") or ""),
            "X-Audition-Source-Seconds": str(_wav_seconds(src)),
            # A candidate is regenerated on demand and never the same twice —
            # nothing about it is cacheable.
            "Cache-Control": "no-store",
        })


@router.get(INGEST + "/{job_id}/preview/{emotion}")
def preview(job_id: str, emotion: str):
    job = _get_job(job_id)
    if not job:
        return job_expired()
    stem = Path(job["work_dir"]) / f"stem_{emotion}.wav"
    if not stem.is_file():
        raise HTTPException(404, "stem not found")
    return FileResponse(str(stem), media_type="audio/wav")


# ── the casting board ─────────────────────────────────────────────────────────
# Serializes re-splices. Two /stems calls for the same job would otherwise write
# the same stem file from two threads (the studio debounces, but a debounce is a
# UI convenience, not a concurrency argument). Global rather than per-job: a
# splice is milliseconds of local wav work, so one lock costs nothing and there
# is no per-job lock lifecycle to leak.
#
# It also serializes a re-splice against the COMMIT FLIP, which is the race the
# 409 in `restem` only looked like it closed: the status was read unlocked, and
# `commit` flipped it to "committing" and handed `stem_{emotion}.wav` to the
# export child while a /stems call that had already passed its check was
# rewriting that same file. LOCK ORDER, everywhere: `_STEM_LOCK` then `_LOCK`.
# `commit` takes `_STEM_LOCK` around the flip, `restem` re-checks the status
# under `_LOCK` INSIDE `_STEM_LOCK`, so one of the two always refuses.
_STEM_LOCK = threading.Lock()
# A hand-curated stem is a handful of takes, not a programme. The cap is a
# boundary check on a client-supplied list, in the same spirit as MAX_UPLOAD_BYTES.
MAX_ASSIGNED_SEGMENTS = 200


def _segment_refusal(index: int, result: dict) -> str:
    """WHY a segment index cannot feed a stem, in the pipeline's own terms.

    "bad index" is four different facts, and a user staring at a greyed row
    deserves the one that applies to it: out of range, extraction failed,
    classification failed, or measured as not the target speaker.
    """
    segs = result.get("segments") or []
    if not isinstance(index, int) or index < 0 or index >= len(segs):
        return f"segment {index} is not part of this scan"
    s = segs[index] if isinstance(segs[index], dict) else {}
    failure = s.get("failure")
    if failure == "extract":
        return (f"segment {index} has no audio - that span of the recording "
                "could not be decoded")
    if failure:
        return f"segment {index} has no audio - it could not be prepared ({failure})"
    if s.get("outlier") == "dropped":
        return (f"segment {index} was measured as not the target speaker, so it "
                "is not available to any stem")
    return f"segment {index} has no audio on this scan"


def _board(work_dir: Path, result: dict) -> tuple[list[dict], dict[str, list[int]], str | None]:
    """(usable segment rows, the splice the PIPELINE proposed, reason-unavailable).

    The proposed map is re-derived from the same inputs `label_and_stem` used
    rather than remembered, so "reset to proposed" restores what the ledger
    actually reported instead of a second, drifting record of it — including the
    baseline's borrow ORDER, which is not recording order (plan_baseline appends
    the topped-up segments after the genuinely-neutral ones, and splicing them
    back in index order would produce a different stem than the one on screen).
    """
    stems = result.get("stems")
    if not isinstance(stems, list) or not stems:
        return [], {}, "this scan produced no stems"
    rows, reason = segment_rows(work_dir, result)
    if reason:
        return [], {}, reason
    min_stem = float(result.get("min_stem") or ingest.MIN_STEM_SECONDS)
    by_emotion: dict[str, list[dict]] = {}
    for r in rows:
        by_emotion.setdefault(r["emotion"], []).append(r)
    proposed: dict[str, list[int]] = {}
    for stem in stems:
        emo = stem.get("emotion")
        if not emo:
            continue
        if emo == ingest.BASELINE:
            proposed[emo] = [l["i"] for l in ingest.plan_baseline(by_emotion, min_stem).labs]
        else:
            proposed[emo] = [r["i"] for r in sorted(by_emotion.get(emo, []),
                                                    key=lambda r: r["i"])]
    return rows, proposed, None


def _mixed_note(emotion: str, indices: list[int], label_of: dict[int, str]) -> str | None:
    """The sentence a HAND-ASSEMBLED stem needs: which of its segments are
    labelled as something else. None when the selection is all one emotion.

    This replaces the pipeline's own note for an edited emotion rather than
    living beside it: `plan_baseline`'s note describes a borrow the user has just
    overruled, and leaving it on screen would state a fact about a stem that no
    longer exists.
    """
    foreign: dict[str, int] = {}
    for i in indices:
        lab = label_of.get(i)
        if lab and lab != emotion:
            foreign[lab] = foreign.get(lab, 0) + 1
    if not foreign:
        return None
    what = ", ".join(f"{n} x {e}" for e, n in sorted(foreign.items()))
    return (f"you assembled this stem: {what} segment(s) in it are labelled as "
            f"another emotion, so this voice is not purely {emotion}.")


def _withdraw_recipes(job: dict, work_dir: Path, stem: dict, emotion: str) -> bool:
    """Drop an edited emotion's candidate takes, and their wavs.

    A recipe is an alternative reading of the PROPOSED selection ("the longest of
    these segments"). Once the user has chosen the segments themselves, every
    alternative describes a set that is no longer on screen — and `full`, the
    default, would name a splice that is not the one in `stem_{emotion}.wav`.
    Withdrawing them means an audition of this emotion hears exactly the stem the
    board just built, and a stale client choice is refused by name at commit
    ("that recipe was not offered for this emotion") instead of quietly cloning
    something else.
    """
    had = bool(stem.pop("recipes", None))
    plan = job.get("recipe_plan") or {}
    for rid in list((plan.get(emotion) or {})):
        if rid == RECIPE_FULL:
            continue
        with contextlib.suppress(OSError):
            (work_dir / f"stem_{emotion}__{rid}.wav").unlink(missing_ok=True)
    had = bool(plan.pop(emotion, None)) or had
    job["recipe_plan"] = plan
    return had


def _refuse_unless_splicable(job: dict) -> None:
    """409 unless this job's stems may still be rewritten.

    Read under `_LOCK` and called TWICE by `restem` — once before the work, and
    again inside `_STEM_LOCK` right before the first byte is written. The second
    call is the one that matters: between the cheap check and the splice sits a
    whole `_board()` re-derivation, and a commit that flips the status in that
    window has already given `stem_{emotion}.wav` to the export child.
    """
    with _LOCK:
        status = job.get("status")
        if job.get("cancel"):
            raise HTTPException(409, "this scan was cancelled")
    if status in ("committing", "committed"):
        raise HTTPException(
            409, "this scan has already been committed - its stems can no longer "
                 "be re-spliced")
    if status != "done":
        raise HTTPException(409, "re-splicing needs a finished scan")


class StemsReq(BaseModel):
    # {emotion: [segment indices]} — the emotions being re-cast. Emotions NOT
    # named keep whatever selection they already have, so a move is one request
    # naming both sides and everything else is left alone.
    assignments: dict[str, list[int]] | None = None
    # Restore the splice the pipeline proposed. An empty body means the same
    # thing: there is no other sensible reading of "re-splice nothing".
    reset: bool = False


@router.post(INGEST + "/{job_id}/stems")
def restem(job_id: str, req: StemsReq):
    """Re-splice this job's stems from a caller-chosen segment selection.

    The stem was the one part of this flow the user had no authority over: a
    mislabelled laugh, a cough, or 0.4s under the clone minimum was a dead end
    shown as a grey badge. This rewrites `stem_{emotion}.wav` from the segments
    the user picked and answers with the measured seconds and the eligibility
    that follows from them - so a short stem can be WATCHED crossing the line
    rather than re-uploaded and hoped about.

    What it deliberately does not do: touch the roster, touch the corpus, admit
    against the job budget (this is local wav arithmetic, not a model load), or
    accept anything that reaches a filename. Refusals are named, one per fact.
    """
    job = _get_job(job_id)
    if not job:
        return job_expired()
    _refuse_unless_splicable(job)

    wd = Path(job["work_dir"])
    result = job.get("result") or {}
    rows, proposed, why = _board(wd, result)
    if why:
        raise HTTPException(409, f"these stems cannot be re-spliced - {why}")
    wav_of = {r["i"]: Path(r["wav"]) for r in rows}
    label_of = {r["i"]: r["emotion"] for r in rows}
    min_stem = float(result.get("min_stem") or ingest.MIN_STEM_SECONDS)
    stem_of = {s.get("emotion"): s for s in result.get("stems") or []}

    reset = bool(req.reset) or not req.assignments
    current: dict[str, list[int]] = dict((job.get("casting") or {}).get("assignments")
                                         or proposed)
    # An emotion the job remembers but this scan no longer proposes cannot be
    # spliced from here; proposed is the authority on what stems exist.
    current = {e: list(v) for e, v in current.items() if e in proposed}
    for emo in proposed:
        current.setdefault(emo, list(proposed[emo]))

    if reset:
        effective = {e: list(v) for e, v in proposed.items()}
    else:
        effective = {e: list(v) for e, v in current.items()}
        for raw_emo, idxs in (req.assignments or {}).items():
            try:
                emo = normalize_emotion(raw_emo)
            except ValueError as exc:
                raise HTTPException(400, str(exc))
            if emo not in proposed:
                raise HTTPException(
                    400, f"'{emo}' is not one of this scan's stems, so segments "
                         "cannot be cast into it")
            if not idxs:
                raise HTTPException(
                    400, f"leave at least one segment in {emo} - to drop the "
                         "emotion entirely, descope it instead")
            if len(idxs) > MAX_ASSIGNED_SEGMENTS:
                raise HTTPException(
                    400, f"too many segments for one stem (max {MAX_ASSIGNED_SEGMENTS})")
            picked: list[int] = []
            for i in idxs:
                if i not in wav_of:
                    raise HTTPException(400, _segment_refusal(i, result))
                if i in picked:
                    raise HTTPException(400, f"segment {i} is listed twice in {emo}")
                picked.append(i)
            effective[emo] = picked

    # Only what actually CHANGED is re-spliced: the same assignments twice write
    # nothing the second time and answer identically (the endpoint is a debounce
    # target, so idempotence is not a nicety here).
    changed = [e for e in effective if effective[e] != current.get(e)]
    edited = sorted(e for e in effective if effective[e] != proposed.get(e))

    with _STEM_LOCK:
        # THE re-check. `commit` cannot flip the status while this is held, so
        # a commit either got here first (and this call refuses) or waits until
        # the stems on disk are the ones this call reports.
        _refuse_unless_splicable(job)
        for emo in changed:
            try:
                sp = ingest.concat_wavs([wav_of[i] for i in effective[emo]],
                                        wd / f"stem_{emo}.wav")
            except Exception as exc:  # noqa: BLE001 - never leak splice internals
                raise errors.sanitized_500("re-splicing this stem", exc)
            stem = stem_of.get(emo)
            if stem is None:
                continue
            stem["seconds"], stem["segments"] = sp.seconds, sp.segments
            # Re-measured on the WRITTEN file, exactly as label_and_stem and
            # commit do — the badge and the clone must agree.
            stem["eligible"] = sp.seconds >= min_stem
            # A hand-assembled stem's identity score described the previous
            # splice. Absent is the honest state; a stale number is not.
            stem.pop("identity", None)
        if reset and changed:
            # Back to the pipeline's own splice, so its own candidate takes are
            # true again. Cleared first: build_recipes only ADDS offers, and a
            # stem that no longer qualifies for a choice must not keep one.
            for stem in result.get("stems") or []:
                stem.pop("recipes", None)
            job["recipe_plan"] = {}
            try:
                plan, _why = build_recipes(wd, result)
                job["recipe_plan"] = plan
            except Exception as exc:  # noqa: BLE001 - takes are advisory, always
                logger.warning("ingest job %s: recipes not rebuilt after reset: %s",
                               job_id, exc)
        else:
            for emo in changed:
                stem = stem_of.get(emo)
                if stem is not None:
                    _withdraw_recipes(job, wd, stem, emo)

        # Still inside _STEM_LOCK: the ledger this call answers with is written
        # before a waiting commit may flip the status, so the numbers published
        # here always describe the audio that commit will clone.
        with _LOCK:
            if job.get("cancel"):
                raise HTTPException(409, "this scan was cancelled")
            casting = dict(job.get("casting") or {})
            # The pipeline's own per-stem notes, snapshotted ONCE so a reset can
            # put them back. plan_baseline's "topped up with 2x calm" is a
            # statement about the proposed splice; restored, never recomputed.
            if "proposed_notes" not in casting:
                casting["proposed_notes"] = {s.get("emotion"): s.get("note")
                                             for s in result.get("stems") or []}
            for emo, stem in stem_of.items():
                if emo in edited:
                    stem["note"] = _mixed_note(emo, effective[emo], label_of)
                else:
                    stem["note"] = casting["proposed_notes"].get(emo)
            casting["assignments"] = effective
            casting["edited"] = edited
            job["casting"] = casting
            job["result"] = result
            _persist(job)

    return {
        "min_stem": min_stem,
        "reset": reset,
        "edited": edited,
        "changed": sorted(changed),
        "stems": [{"emotion": emo,
                   "seconds": stem.get("seconds"),
                   "segments": stem.get("segments"),
                   "eligible": bool(stem.get("eligible")),
                   "note": stem.get("note"),
                   "assigned": effective.get(emo, []),
                   "proposed": proposed.get(emo, []),
                   "edited": emo in edited,
                   # Whether an A/B of alternative takes still exists for this
                   # row. False after an edit, and the studio must stop offering
                   # one rather than let it 404 at commit.
                   "takes": bool(stem.get("recipes"))}
                  for emo, stem in stem_of.items() if emo in proposed],
    }


@router.get(INGEST + "/{job_id}/segment/{index}")
def segment(job_id: str, index: int):
    """One labelled segment's own audio. The sibling of `speaker-preview`.

    The scan has always written these (`seg_%03d.wav`) and always thrown them
    away behind a single per-stem number. Serving them is what makes the "mixed"
    note, an outlier badge and a 3.6s stem explicable instead of assertions the
    user has to take on faith — including for segments the pipeline REJECTED,
    which are precisely the ones somebody wants to hear.
    """
    job = _get_job(job_id)
    if not job:
        return job_expired()
    result = job.get("result") or {}
    segs = result.get("segments") or []
    if index < 0 or index >= len(segs):
        raise HTTPException(404, "that segment is not part of this scan")
    p = Path(job["work_dir"]) / f"seg_{index:03d}.wav"
    if not p.is_file():
        raise HTTPException(404, _segment_refusal(index, result))
    return FileResponse(str(p), media_type="audio/wav")


class CommitReq(BaseModel):
    character: str
    emotions: list[str]
    character_id: str | None = None
    # Server-side consent gate: a direct API caller must attest ownership, and
    # the statement is stored as a receipt on every created Voice.
    attested: bool = False
    statement: str = ""
    # {emotion: recipe_id} — the candidate splice the user auditioned and chose.
    # Absent, empty or `full` for an emotion all mean the same thing: clone what
    # the ledger showed. The fast path never sends this.
    recipes: dict[str, str] | None = None
    # Keep this recording's segments, labels, stems and levels for this
    # character (see ingest.capture_corpus). None = whatever the scan asked for
    # (default OFF); an explicit true/false here wins, because the decision to
    # RETAIN belongs at the moment of consent, not at upload.
    corpus: bool | None = None


@router.post(INGEST + "/{job_id}/commit")
def commit(job_id: str, req: CommitReq):
    """Kick off cloning as a background phase and return immediately. Progress
    (emotions_done / total / current) streams via `partial`; the job ends
    'committed' or 'error'. Poll GET /{job} to follow it."""
    # Boundary validation, BEFORE admission: both fields are client-supplied and
    # both end up in filenames downstream (ingest.commit builds
    # `stem_{emotion}.wav` and the `{cid}-{emotion}-….safetensors` destination),
    # so an unvalidated `..` here writes outside the voices directory. Same rule
    # as every other write path: emotions go through `normalize_emotion`, and a
    # character id must already be its own slug. Reject, never sanitise.
    try:
        emotions = [normalize_emotion(e) for e in req.emotions]
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    if req.character_id is not None and req.character_id != voices._slug(req.character_id):
        raise HTTPException(400, "character_id is not a valid character id")
    # Recipe choices are keys into a server-side plan, and BOTH halves reach a
    # filename (`stem_{emotion}__{recipe}.wav`) — so both are validated the same
    # way the emotions above are: normalized/enumerated, never sanitised.
    chosen: dict[str, str] = {}
    for emo, rid in (req.recipes or {}).items():
        try:
            emo = normalize_emotion(emo)
        except ValueError as exc:
            raise HTTPException(400, str(exc))
        if rid not in RECIPE_ORDER:
            raise HTTPException(400, "unknown recipe")
        chosen[emo] = rid
    _admit()  # cloning loads the TTS model in a child process — the heaviest phase
    # _STEM_LOCK first (see the lock-order note on the casting board): the flip
    # to "committing" is what makes `restem` refuse, so it must not land while a
    # re-splice is midway through rewriting the very stems this commit clones.
    with _STEM_LOCK, _LOCK:
        job = JOBS.get(job_id)
        if not job:
            return job_expired()
        if job["status"] != "done":
            raise HTTPException(409, "scan not finished")
        if not req.character.strip() and not req.character_id:
            raise HTTPException(400, "character name required")
        statement = req.statement.strip()
        if not req.attested or not statement:
            raise HTTPException(422, "ownership attestation required to clone a voice")
        want_corpus = ((job.get("corpus") or {}).get("requested", False)
                       if req.corpus is None else bool(req.corpus))
        job["status"] = "committing"
        job["cancel"] = False
        job["committed"] = None
        job["corpus"] = {"requested": want_corpus, "captured": False,
                         "reason": None if want_corpus
                         else "corpus capture was not requested"}
        job["partial"] = {"emotions_done": 0, "emotions_total": len(emotions), "current": None}
        _persist(job)
    _spawn(_do_commit,
           (job_id, req.character.strip(), emotions, req.character_id, statement,
            chosen, want_corpus), f"ingest-commit-{job_id}")
    return {"status": "committing"}


class RederiveReq(BaseModel):
    character_id: str
    # Which emotions to rebuild. Absent = every emotion the corpus holds audio
    # for, which is the point of the feature (one click, whole character).
    emotions: list[str] | None = None


def _valid_cid(character_id: str) -> str:
    cid = (character_id or "").strip()
    if not cid or cid != voices._slug(cid):
        raise HTTPException(400, "character_id is not a valid character id")
    return cid


@router.post(INGEST + "/rederive")
def start_rederive(req: RederiveReq) -> dict:
    """Rebuild a character's voices from its stored corpus — no upload, no cloud
    call, no new consent (the receipt stored with the audio is the consent).

    The three refusals are answered HERE, synchronously, so a caller learns "you
    have no corpus" as a 404 rather than as a job that fails a minute later:
      404 — nothing has ever been captured for this character;
      409 — the corpus is over its byte cap (prune or delete first), or holds no
            audio for the emotions asked for.
    Everything past that is a background job with the same poll surface as a
    commit: GET /v1/ingest/{job_id}, DELETE to cancel.
    """
    cid = _valid_cid(req.character_id)
    emotions: list[str] | None = None
    if req.emotions is not None:
        try:
            emotions = [normalize_emotion(e) for e in req.emotions]
        except ValueError as exc:
            raise HTTPException(400, str(exc))
    try:
        idx = ingest.load_corpus(cid)
    except errors.UserFacing as exc:
        raise HTTPException(400, str(exc))
    if not idx.get("clips"):
        raise HTTPException(
            404, "there is no corpus for this character — capture is opt-in, so "
                 "re-run an ingest with corpus enabled before rebuilding from it")
    used = ingest.corpus_bytes(idx)
    cap = SETTINGS.corpus_max_bytes
    if cap > 0 and used > cap:
        raise HTTPException(
            409, f"this character's corpus is {used} bytes, over its {cap}-byte "
                 "cap — delete recordings before rebuilding from it")
    sel = ingest.select_best(cid, emotions, idx)
    if not any(rows for rows in sel["picks"].values()):
        raise HTTPException(
            409, "nothing in this character's corpus matches what was asked "
                 "for, so there is nothing to rebuild")

    _admit()   # a rebuild loads the TTS model in a child, exactly like a commit
    job_id = uuid.uuid4().hex[:12]
    work_dir = WORK_ROOT / job_id
    work_dir.mkdir(parents=True, exist_ok=True)
    _write_owner(work_dir)
    job = {
        "id": job_id, "status": "committing", "step": None, "mode": "rederive",
        "steps": [{**s, "state": "pending"} for s in STEPS_BY_MODE["rederive"]],
        "partial": {"emotions_done": 0,
                    "emotions_total": sum(1 for r in sel["picks"].values() if r),
                    "current": None},
        "speakers": None, "duration": 0, "result": None, "error": None,
        "note": None, "limits": None, "detection": None,
        "work_dir": str(work_dir), "created": time.time(),
        "clip_sha256": None, "cancel": False, "committed": None,
        "recipes": None, "recipe_plan": {}, "casting": None,
        # A rebuild reads the corpus and never writes to it.
        "corpus": {"requested": False, "captured": False,
                   "reason": "a re-derivation reads the corpus, it never adds "
                             "to it", "corpus_rev": sel["corpus_rev"]},
        "character_id": cid}
    with _LOCK:
        JOBS[job_id] = job
        _persist(job)
    _spawn(_do_rederive, (job_id, cid, emotions), f"ingest-rederive-{job_id}")
    return {"job_id": job_id, "mode": "rederive",
            "selection": sel["report"], "corpus_rev": sel["corpus_rev"]}


@router.get("/v1/characters/{character_id}/corpus")
def get_corpus(character_id: str) -> dict:
    """What audio of this person the box holds — clips, their segments, seconds,
    emotions, measured fidelity and the consent receipt each was kept under.

    Answers for a character with NO corpus too (empty, `totals.clips = 0`)
    rather than 404: "this box keeps nothing of yours" is the answer to the
    question, and a 404 would read as "we could not check".
    """
    cid = _valid_cid(character_id)
    try:
        return ingest.corpus_view(cid)
    except errors.UserFacing as exc:
        raise HTTPException(400, str(exc))


@router.delete("/v1/characters/{character_id}/corpus/{clip_sha}")
def delete_corpus_clip(character_id: str, clip_sha: str) -> dict:
    """Remove every segment and stem derived from ONE recording, and report what
    went. Deliberately not a 204: a deletion the user cannot see the shape of is
    a deletion they have to take on trust, and this is the surface that makes
    keeping the audio defensible in the first place.

    The Voices already cloned from that recording are NOT touched — they are
    embeddings the user asked for and owns; delete them through /v1/voices.
    """
    cid = _valid_cid(character_id)
    try:
        report = ingest.delete_clip(cid, clip_sha)
    except errors.UserFacing as exc:
        raise HTTPException(400, str(exc))
    if report.get("removed") is None:
        raise HTTPException(404, report.get("reason") or "no such recording")
    return report


@router.delete(INGEST + "/{job_id}")
def cancel_job(job_id: str):
    """Cancel a job (between emotions during commit, between phases otherwise),
    mark it 'cancelled' and tear down its workdir.

    A cancelled RE-DERIVATION keeps the voices it had already rebuilt, so the
    teardown leaves a receipt behind and the response says so — the answer used
    to be a bare {"status": "cancelled"} for an operation that had already
    replaced part of the user's character.
    """
    with _LOCK:
        job = JOBS.get(job_id)
        if not job:
            return job_expired()
        job["cancel"] = True
        job["status"] = "cancelled"
        work_dir = job["work_dir"]
        is_rederive = job.get("mode") == "rederive"
        JOBS.pop(job_id, None)
        _SPEND.pop(job_id, None)
    rebuilt: list[dict] = []
    if is_rederive:
        # The phase thread is still running and will finalize this receipt;
        # writing it here means the outcome exists even if the thread never
        # got far enough to write one (cancelled before it started).
        prior = _read_receipt(job_id) or {}
        rebuilt = list((prior.get("rederive") or {}).get("voices") or [])
        _record_rederive(job, "cancelled", rebuilt)
    shutil.rmtree(work_dir, ignore_errors=True)
    forget_metrics(work_dir)
    if is_rederive:
        return {"status": "cancelled", "rebuilt": rebuilt, "kept": True}
    return {"status": "cancelled"}


# ── startup / shutdown ────────────────────────────────────────────────────────
_started = False
_gc_thread: threading.Thread | None = None
# What a phase gets to finish once shutdown has begun. Kept well under the
# engine's own drain budget by the caller (Settings.drain_timeout_s), because
# the orchestrator's stop grace has to cover BOTH.
DRAIN_GRACE_S = 10.0


def start_background() -> None:
    """Rehydrate persisted jobs and start the GC sweeper. Called from the app
    lifespan — NOT at import.

    Doing this at import meant real disk work (scanning WORK_ROOT, rewriting
    state.json) ran before the app was ready and outside lifespan supervision,
    and every process that imported this module for any reason — a CLI, a test
    runner — silently spawned a GC thread that could delete another replica's
    workdirs. Tests in particular shared that live thread with the production
    module globals they patch. Idempotent.
    """
    global _started, _gc_thread
    with _LOCK:
        if _started:
            return
        _started = True
    _STOP.clear()
    # Beat BEFORE claiming anything: a sibling replica starting in the same
    # second must be able to see that we are alive, or two processes could each
    # decide the other is dead and both claim the same job.
    _beat()
    _rehydrate()
    _gc_thread = threading.Thread(target=_gc_loop, args=(_STOP,), daemon=True,
                                  name="ingest-gc")
    _gc_thread.start()


def stop_background(grace: float = DRAIN_GRACE_S) -> dict:
    """Drain ingest. The other half of `start_background`, and it did not exist.

    The lifespan drained ENGINE and nothing else, so SIGTERM landed on daemon
    threads that were never joined: a commit mid-clone had rows already
    registered through `voices.mutate_meta` and its `_rollback` still ahead of
    it, and the next boot relabelled the job "interrupted by restart" without
    undoing anything. The partial Character survived, unnoticed.

    So: stop the sweeper (it WAKES on the event — a five-minute sleep is not a
    shutdown), give the phases in flight a bounded grace to reach their own
    terminal handling, release this process's ownership so a restart adopts its
    jobs at once rather than after `_OWNER_STALE_S`, and REPORT what could not
    be waited out. Whatever a phase could not finish is reconciled at the next
    startup from its journal (`_reconcile`), which is the guarantee this pairs
    with: the grace is an optimization, not the safety net.
    """
    global _started, _gc_thread
    _STOP.set()
    deadline = time.monotonic() + max(0.0, grace)
    gc = _gc_thread
    if gc is not None and gc.is_alive():
        gc.join(timeout=max(0.1, deadline - time.monotonic()))
    with _LOCK:
        phases = [p for p in _PHASES if p.is_alive()]
    unfinished: list[str] = []
    for t in phases:
        t.join(timeout=max(0.0, deadline - time.monotonic()))
        if t.is_alive():
            unfinished.append(str(getattr(t, "name", t)))
    if unfinished:
        logger.warning(
            "ingest drain: %d phase(s) did not finish within %.0fs and were "
            "left to the restart's reconciliation: %s",
            len(unfinished), grace, ", ".join(unfinished))
    else:
        logger.info("ingest drain: %d phase(s) finished", len(phases))
    _release_owner()
    with _LOCK:
        _started = False
        _PHASES[:] = [p for p in _PHASES if p.is_alive()]
    _gc_thread = None
    return {"phases": len(phases), "unfinished": unfinished,
            "gc_stopped": gc is None or not gc.is_alive()}
