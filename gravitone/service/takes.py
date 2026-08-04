"""Shared takes + review sets — persisted renders behind public pages.

A take in the studio lives only in React state as a blob URL; sharing needs
it server-side. A shared take = one wav + one metadata JSON (character, the
metatagged text, the per-segment emotion report, timing) under
`<data>/takes/`. The web app serves them at /t/{id} as branded Voice Cards
with an emotion-synced player; each share is a landing page demonstrating
the emotion-metatag differentiator.

A REVIEW SET bundles 2-6 takes of the same script for client approval: the
creator sends one link, the client picks the winner on a no-login page, and
the pick is recorded. Voiceover work is approval-driven — this is the loop
agencies currently run over emailed WAV attachments. Accumulated picks also
answer "what should the studio default to" (see preferred()).

Bounded store: oldest takes/reviews are evicted past their caps — shares are
a marketing surface, not an archive.

LINEAGE: a take may be DERIVED from another (open a share back in the rack,
change one [emotion] tag, re-render). The child records `parent_id` +
`derived_from`, so /t/{id} can show provenance, `GET /v1/takes/{id}/lineage`
can walk the chain, and `direction.py` can count what the human changed.
Eviction is lineage-aware: dropping a mid-chain link would leave a child
pointing at a parent that no longer exists, so the store evicts LEAF-FIRST.

CAST: a take's segments each name WHO SPOKE THEM (`character_id` +
`character_name`), so an ensemble take survives publication as an ensemble.
Before this, a multi-character performance was stored under the FIRST line's
character with the label "Ensemble - N voices" and a flat list of segments
that named nobody — the share page could draw one rail, the re-perform path
had one voice to work with, and the scene the studio composed was gone the
moment it was shared. The fields are OPTIONAL at every layer: a solo take
carries neither, and every take published before they existed reads as one
that names no cast, which is exactly what it is.

PUBLIC RE-PERFORM: a visitor to /t/{id} may edit the text and render a CHILD
take — but only if the publisher opted in (`allow_reperform`, default OFF).
That flag is the whole consent model: forking puts NEW WORDS in someone's
voice, so it is a decision the publisher makes at publish time, never a
default the product makes for them. The render costs this box real CPU, so it
is bounded by the shared per-IP limiter (service/ratelimit.py) and by a text
cap far below the studio's own, and the child is minted WITHOUT the flag — a
fork is a leaf, not the start of an unbounded public chain.
"""
from __future__ import annotations

import asyncio
import json
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from service import direction
from service.atomicio import atomic_write_bytes, atomic_write_text, file_lock
from service.config import SETTINGS
# The one WAV joiner in the service (24 kHz mono 16-bit, no ffmpeg). A cast
# re-perform renders one line per Character and joins them; engine.py imports
# no service module, so this is a leaf import and not the cycle app.py is.
from service.engine import concat_wavs
from service.ratelimit import per_ip_budget

router = APIRouter(prefix="/v1/takes", tags=["takes"])
reviews_router = APIRouter(prefix="/v1/reviews", tags=["reviews"])

TAKES_DIR = Path(SETTINGS.voices_dir).parent / "takes"
REVIEWS_DIR = Path(SETTINGS.voices_dir).parent / "reviews"
MAX_TAKES = 500
MAX_REVIEWS = 200
MAX_AUDIO_BYTES = 25 * 1024 * 1024  # ~4 min of 24 kHz wav
MAX_TEXT = 8000
MAX_SEGMENTS = 200
MAX_LINEAGE_DEPTH = 20     # ancestors walked before the answer says so
MAX_LINEAGE_CHILDREN = 50  # children listed per take
MAX_DERIVED_KEYS = 10      # fields kept from a client's derived_from block
# A public fork is one edited line or two, not a script: a visitor spending
# this box's CPU gets a fraction of MAX_TEXT. Refused by NAME, not by a
# pydantic 422, because the panel shows the sentence to a human.
MAX_REPERFORM_TEXT = 1000
# How many CAST LINES one public re-perform may be split into. The compute
# budget is the character cap above, which is enforced over the SUM of the
# lines — so a cast re-perform costs the box exactly what a single-voice one of
# the same length costs. This cap exists only to bound the number of separate
# render calls (each pays its own model setup and admission).
MAX_REPERFORM_LINES = 12

# The public-compute budget. Deliberately small and slow: a fork is seconds of
# CPU on a box that is also serving the studio, and the honest ceiling for an
# anonymous visitor is "a few tries, then come back later". Named "reperform"
# so /metrics-shaped introspection and the tests can find it.
REPERFORM_BUDGET = per_ip_budget("reperform", limit=5, window_s=300, burst=2)

# Publishing a take is an anonymous 25 MB upload into a bounded store, and it
# had no budget at all: one client could churn the entire share store (and its
# disk) as fast as it could send. Slower than a render but far from tight — a
# studio session ends in a handful of shares, and every studio visitor arrives
# as ONE address until TTS_TRUST_PROXY is on, so this is a budget for the room:
# 60 uploads per 10 minutes, six at a time. Env-tunable, because the honest
# number depends on the box's disk and its audience.
def _upload_limit() -> int:
    try:
        return max(1, int(os.environ.get("TTS_BUDGET_TAKE_UPLOAD", "") or 60))
    except ValueError:
        return 60


UPLOAD_BUDGET = per_ip_budget("take-upload", limit=_upload_limit(),
                              window_s=600, burst=6, methods=("POST",))


# Both stores are bounded, and "bound" is a read-modify-write of a DIRECTORY:
# list it, decide what to drop, drop it, add one. Two replicas doing that at
# once can each decide the store is full and each evict — or evict the file the
# other just wrote. `os.replace` says nothing about that; only a cross-process
# mutex does. Derived at call time so redirecting the store (deployments do;
# tests do) moves the lock with it.
def _takes_lock() -> Path:
    return TAKES_DIR / ".takes.lock"


def _reviews_lock() -> Path:
    return REVIEWS_DIR / ".reviews.lock"


def _valid_id(take_id: str) -> bool:
    """Ids are minted here (10 hex chars); anything else is a caller's string
    and must not become a path segment."""
    return bool(take_id) and take_id.isalnum() and len(take_id) <= 32


def _read_meta(take_id: str) -> dict | None:
    if not _valid_id(take_id):
        return None
    return _read_meta_path(TAKES_DIR / f"{take_id}.json")


def _read_meta_path(path: Path) -> dict | None:
    try:
        data = json.loads(path.read_text("utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return data if isinstance(data, dict) else None


def _parent_of(meta: dict | None) -> str:
    pid = str((meta or {}).get("parent_id") or "")
    return pid if _valid_id(pid) else ""


def _drop(path: Path) -> None:
    path.with_suffix(".wav").unlink(missing_ok=True)
    path.unlink(missing_ok=True)


def _evict_oldest() -> None:
    """Make room for one new take without orphaning a lineage.

    Oldest-first is still the rule, with one addition: a take whose CHILD is
    still in the store is skipped, because deleting a mid-chain link leaves the
    child pointing at a parent that no longer exists — `/lineage` would report a
    hole in the middle of a chain it should be able to walk. Removing leaves
    first strips a chain from its tip inward, so whatever survives is always a
    complete chain back to its root.

    Last resort: if a pass frees nothing (only reachable if the store was
    hand-edited into a parent cycle), the oldest remaining take goes anyway —
    a wedged writer would be worse than a broken link.
    """
    try:
        entries = [(p.stem, p.stat().st_mtime, p) for p in TAKES_DIR.glob("*.json")]
    except OSError:
        return
    need = len(entries) - MAX_TAKES + 1
    if need <= 0:
        return  # the common path never reads a single metadata file

    entries.sort(key=lambda e: e[1])
    ids = {tid for tid, _, _ in entries}
    parents = {tid: _parent_of(_read_meta_path(p)) for tid, _, p in entries}
    kids: dict[str, int] = {}
    for tid, pid in parents.items():
        if pid in ids:
            kids[pid] = kids.get(pid, 0) + 1

    removed: set[str] = set()
    while need > 0:
        freed = 0
        for tid, _, path in entries:
            if need == 0:
                break
            if tid in removed or kids.get(tid, 0) > 0:
                continue
            _drop(path)
            removed.add(tid)
            need -= 1
            freed += 1
            pid = parents.get(tid, "")
            if pid in kids:
                kids[pid] -= 1
        if freed == 0:
            for tid, _, path in entries:
                if tid not in removed:
                    _drop(path)
                    removed.add(tid)
                    need -= 1
                    break
            else:
                return
            if need <= 0:
                return


def _clean_derived_from(raw: object) -> dict:
    """Keep a caller's provenance block, bounded. It is display + telemetry
    metadata, never trusted input: strings are truncated, structures other than
    scalars and short string lists are dropped."""
    if not isinstance(raw, dict):
        return {}
    out: dict = {}
    for key, value in list(raw.items())[:MAX_DERIVED_KEYS]:
        name = str(key)[:32]
        if isinstance(value, bool) or isinstance(value, (int, float)):
            out[name] = value
        elif isinstance(value, str):
            out[name] = value[:200]
        elif isinstance(value, list):
            out[name] = [str(v)[:64] for v in value[:20]]
    return out


def _summary(meta: dict) -> dict:
    """The compact shape lineage answers in — never the whole take."""
    return {
        "id": str(meta.get("id", ""))[:32],
        "character_id": str(meta.get("character_id", ""))[:100],
        "character_name": str(meta.get("character_name", ""))[:100],
        "seconds": float(meta.get("seconds", 0) or 0),
        "created": str(meta.get("created", ""))[:32],
        "derived_from": meta.get("derived_from") or {},
        "missing": False,
    }


# NOT async: writes up to 25 MB and globs/stats the whole takes dir to evict.
@router.post("", status_code=201, dependencies=[Depends(UPLOAD_BUDGET)])
def create_take(
    file: UploadFile = File(...),
    meta: str = Form(...),
) -> dict:
    """Persist one rendered take (wav + metadata) and mint its share id."""
    try:
        m = json.loads(meta)
    except json.JSONDecodeError:
        raise HTTPException(400, "meta must be JSON")

    text = str(m.get("text", ""))[:MAX_TEXT]
    segments = m.get("segments") or []
    if not text or not isinstance(segments, list) or len(segments) > MAX_SEGMENTS:
        raise HTTPException(400, "meta needs text and a segments list")

    audio = file.file.read()  # sync read — we're on the threadpool
    if not audio or len(audio) > MAX_AUDIO_BYTES:
        raise HTTPException(400, f"audio must be 1 byte to {MAX_AUDIO_BYTES // 2**20} MB")
    if audio[:4] != b"RIFF":
        raise HTTPException(400, "audio must be a wav file")

    # Lineage is OPTIONAL and additive: a client that knows nothing about it
    # posts exactly what it posted before. An unknown parent (evicted between
    # the fork and the render) is kept rather than rejected — losing a rendered
    # take over a missing ancestor would be the worse failure, and every
    # lineage reader already tolerates a member that is gone.
    parent_id = str(m.get("parent_id") or "").strip()
    if parent_id and not _valid_id(parent_id):
        raise HTTPException(400, "parent_id must be an alphanumeric take id")

    record = _build_record(
        character_id=str(m.get("character_id", ""))[:100],
        character_name=str(m.get("character_name", "Character"))[:100],
        text=text,
        seconds=float(m.get("seconds", 0) or 0),
        rtf=float(m.get("rtf", 0) or 0),
        segments=segments,
        parent_id=parent_id,
        derived_from=_clean_derived_from(m.get("derived_from")),
        # Publish-time opt-in for public re-perform. Absent = OFF: every take
        # published before this existed is not forkable, which is the only
        # reading of an unanswered consent question.
        allow_reperform=bool(m.get("allow_reperform", False)),
    )
    _write_take(record, audio)
    return {"take_id": record["id"]}


def _clean_segment(s: dict) -> dict:
    """One stored segment: what was said, which emotion was asked for and used,
    how long it took — and WHO SPOKE IT, when the client said so.

    The cast pair is written only when it is actually present, so a solo take's
    record is byte-identical to what it has always been and a reader can tell
    "this take names no cast" from "this segment was spoken by nobody".
    """
    out = {
        "text": str(s.get("text", ""))[:300],
        "requested": str(s.get("requested", "baseline"))[:32],
        "used": str(s.get("used", "baseline"))[:32],
        "fallback": bool(s.get("fallback", False)),
        "seconds": float(s.get("seconds", 0) or 0),
    }
    cid = str(s.get("character_id") or "")[:100]
    cname = str(s.get("character_name") or "")[:100]
    if cid:
        out["character_id"] = cid
        # A name without an id would be a label pointing at nothing — the id is
        # what /t/{id} lanes and re-perform address, so the name rides with it.
        if cname:
            out["character_name"] = cname
    return out


def cast_of(meta: dict) -> dict[str, str]:
    """The take's cast: character id -> display name, in first-spoken order.

    Empty for a take that names no cast — a solo take, or one published before
    segments carried a speaker. Callers must treat that as "unknown", never as
    "one voice": a legacy ensemble take is indistinguishable from a solo one
    HERE, which is precisely why the re-perform path says so out loud instead
    of guessing.
    """
    out: dict[str, str] = {}
    for s in meta.get("segments") or []:
        if not isinstance(s, dict):
            continue
        cid = str(s.get("character_id") or "")
        if cid and cid not in out:
            out[cid] = str(s.get("character_name") or "") or cid
    return out


def _build_record(*, character_id: str, character_name: str, text: str,
                  seconds: float, rtf: float, segments: list,
                  parent_id: str = "", derived_from: dict | None = None,
                  allow_reperform: bool = False) -> dict:
    """The on-disk shape of one take. Shared by the upload route and the
    server-side re-perform render, so a forked take is the same record a
    published one is — same caps, same fields, same reader."""
    return {
        "id": uuid.uuid4().hex[:10],
        "character_id": character_id,
        "character_name": character_name,
        "text": text,
        "seconds": seconds,
        "rtf": rtf,
        "segments": [_clean_segment(s) for s in segments if isinstance(s, dict)],
        "created": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "parent_id": parent_id or None,
        "derived_from": derived_from or None,
        "allow_reperform": allow_reperform,
    }


def _write_take(record: dict, audio: bytes) -> None:
    """Evict, write the pair, and count the direction delta. Blocking by
    construction (up to 25 MB plus a glob of the store) — callers on the event
    loop must hand it to a thread."""
    TAKES_DIR.mkdir(parents=True, exist_ok=True)
    with file_lock(_takes_lock()):
        _evict_oldest()
        # Atomic, and the WAV first: a reader finds a take through its JSON, so
        # the pair only ever becomes visible in an order where the audio is
        # already whole. Bare writes left both halves torn if the process died
        # mid-write — 25 MB is the widest such window this service has.
        atomic_write_bytes(TAKES_DIR / f"{record['id']}.wav", audio)
        atomic_write_text(TAKES_DIR / f"{record['id']}.json", json.dumps(record))

    # The diff between parent and child is a human direction decision. Counted
    # after the take is safely on disk, and never able to fail it.
    parent_id = record.get("parent_id") or ""
    if parent_id:
        parent_meta = _read_meta(parent_id)
        if parent_meta is not None:
            direction.record_delta(parent_meta, record)


@router.get("/{take_id}")
def get_take(take_id: str) -> dict:
    p = TAKES_DIR / f"{take_id}.json"
    if not take_id.isalnum() or not p.is_file():
        raise HTTPException(404, "take not found (shares are evicted oldest-first)")
    return json.loads(p.read_text("utf-8"))


@router.get("/{take_id}/lineage")
def get_lineage(take_id: str) -> dict:
    """The chain this take belongs to: ancestors (nearest first) and children.

    Bounded on both axes — a walk stops at MAX_LINEAGE_DEPTH and says so
    (`depth_capped`), and children are capped with the true total alongside.
    An ancestor that has been evicted is REPORTED (`missing: true`) rather than
    silently ending the chain, because "the parent is gone" and "there was no
    parent" are different sentences on a provenance line.
    """
    meta = _read_meta(take_id)
    if meta is None:
        raise HTTPException(404, "take not found (shares are evicted oldest-first)")

    ancestors: list[dict] = []
    seen = {take_id}
    depth_capped = False
    cursor = _parent_of(meta)
    while cursor:
        if cursor in seen:  # a hand-edited store could describe a cycle
            break
        seen.add(cursor)
        if len(ancestors) >= MAX_LINEAGE_DEPTH:
            depth_capped = True
            break
        parent_meta = _read_meta(cursor)
        if parent_meta is None:
            ancestors.append({"id": cursor, "missing": True})
            break
        ancestors.append(_summary(parent_meta))
        cursor = _parent_of(parent_meta)

    children: list[dict] = []
    if TAKES_DIR.is_dir():
        for path in TAKES_DIR.glob("*.json"):
            child = _read_meta_path(path)
            if child is not None and _parent_of(child) == take_id:
                children.append(_summary(child))
    children.sort(key=lambda c: c["created"])
    return {
        "id": take_id,
        "take": _summary(meta),
        "ancestors": ancestors,
        "children": children[:MAX_LINEAGE_CHILDREN],
        "children_total": len(children),
        "depth_capped": depth_capped,
    }


@router.get("/{take_id}/audio")
def get_take_audio(take_id: str) -> FileResponse:
    p = TAKES_DIR / f"{take_id}.wav"
    if not take_id.isalnum() or not p.is_file():
        raise HTTPException(404, "take audio not found")
    return FileResponse(str(p), media_type="audio/wav")


# ── public re-perform (a share is a fork point) ───────────────────────────────
# The renderer, handed over rather than imported. `service/app.py` owns the
# synthesis machinery (/v1/speak resolves a Character's per-emotion voices,
# admits against the worker pool and reports what it substituted) and it
# imports THIS module for its router — so importing it back would be the cycle.
# Same seam, and same reason, as `convai.set_engine_provider`.
#
# Contract: `await provider(character_id, text) -> {audio: bytes (wav),
# segments: [...], seconds: float, rtf: float}`, raising HTTPException for a
# refusal the caller should see (unknown Character, backpressure). None = this
# process has no renderer wired, which is a NAMED refusal, not a 500.
_SPEAK_PROVIDER = None


def set_speak_provider(provider) -> None:
    global _SPEAK_PROVIDER
    _SPEAK_PROVIDER = provider


class ReperformLine(BaseModel):
    """One line of a CAST re-perform: who says it, and what they now say."""
    character_id: str = Field(..., min_length=1, max_length=100)
    text: str = Field(..., min_length=1)


class ReperformReq(BaseModel):
    """One edit, one render. The text is the parent's, as the visitor changed
    it — emotion metatags and all.

    Two forms, exactly one of them per request:

      * ``text``  — the whole re-performance in ONE voice (the parent take's
        Character). This is the original shape and is unchanged on the wire.
      * ``lines`` — a CAST re-performance: one entry per speaker line, each
        rendered in its own Character's voice and concatenated in order. Only
        Characters the PARENT take actually cast may appear: consent was given
        for re-performing THIS take, not for putting words in any voice this
        box happens to host.

    ``text`` lost its ``min_length=1`` so the cast form does not have to send a
    dummy; the handler refuses an empty request BY NAME, which is what a
    visitor reading the panel needs instead of a 422.
    """
    text: str = Field("")
    lines: list[ReperformLine] = Field(default_factory=list,
                                       max_length=MAX_REPERFORM_LINES)


@router.post("/{take_id}/reperform", status_code=201,
             dependencies=[Depends(REPERFORM_BUDGET)])
async def reperform(take_id: str, req: ReperformReq) -> dict:
    """Fork a published take: render the edited words and mint a CHILD take.

    IN WHOSE VOICE depends on what the parent take actually recorded. A take
    whose segments name a cast is re-performed line by line, each line in its
    own Character's voice; a take that names no cast is re-performed in the one
    Character it does name — and the response SAYS SO (``single_voice`` plus a
    ``notice``). It used to say nothing at all while flattening an entire
    ensemble into its first speaker's voice, which is the one outcome a
    listener could not detect from the result.

    Every refusal is named, because this runs for an anonymous visitor who
    cannot read a log: `not-published-for-reperform` (the publisher did not opt
    in), `empty`, `too-long`, `ambiguous` (both request forms sent),
    `cast-mismatch` (a Character the parent never cast), `engine-absent`, plus
    the limiter's `rate-limited` (429 + Retry-After) and whatever the render
    path itself says (a 429 for backpressure, a 404 for a Character deleted
    since the take was published).

    The child is NOT itself forkable: consent was given for one fork of one
    published take, and inheriting the flag would turn one opt-in into an
    unbounded public render chain.
    """
    parent = _read_meta(take_id)
    if parent is None:
        raise HTTPException(404, "take not found (shares are evicted oldest-first)")
    if not bool(parent.get("allow_reperform")):
        raise HTTPException(
            403, "not-published-for-reperform: whoever published this take did "
                 "not open it for public re-performance")

    cast = cast_of(parent)
    parts = _reperform_parts(req, parent, cast)

    provider = _SPEAK_PROVIDER
    if provider is None:
        raise HTTPException(
            503, "engine-absent: this deployment has no renderer wired for "
                 "public re-performance")

    wavs: list[bytes] = []
    segments: list[dict] = []
    seconds = 0.0
    synth_seconds = 0.0
    for character_id, line_text in parts:
        try:
            rendered = await provider(character_id, line_text)
        except HTTPException:
            raise  # already a named refusal from the render path (404 / 429 / 503)
        except Exception as exc:  # noqa: BLE001 - a render failure is not a crash report
            raise HTTPException(502, f"render-failed: {type(exc).__name__}") from exc

        audio = rendered.get("audio") or b""
        if not isinstance(audio, (bytes, bytearray)) or audio[:4] != b"RIFF":
            raise HTTPException(502, "render-failed: the renderer returned no wav")
        wavs.append(bytes(audio))
        # Every segment of the child records WHO SPOKE IT, so the fork of an
        # ensemble is itself an ensemble take and its own share page can lane it.
        name = cast.get(character_id) or str(parent.get("character_name", "Character"))
        for seg in list(rendered.get("segments") or []):
            if isinstance(seg, dict):
                segments.append({**seg, "character_id": character_id,
                                 "character_name": name})
        line_seconds = float(rendered.get("seconds", 0) or 0)
        seconds += line_seconds
        line_rtf = float(rendered.get("rtf", 0) or 0)
        if line_rtf > 0:
            synth_seconds += line_seconds / line_rtf

    # Joining N wavs walks every sample; the handler is on the event loop.
    audio = wavs[0] if len(wavs) == 1 else await asyncio.to_thread(concat_wavs, wavs)
    if len(audio) > MAX_AUDIO_BYTES:
        raise HTTPException(
            413, f"too-long: the render is over {MAX_AUDIO_BYTES // 2**20} MB")

    voices = list(dict.fromkeys(cid for cid, _ in parts))
    single_voice = len(voices) == 1
    names = [cast.get(cid) or str(parent.get("character_name", "Character"))
             for cid in voices]
    record = _build_record(
        character_id=parts[0][0],
        character_name=(names[0] if single_voice
                        else f"Ensemble - {len(voices)} voices")[:100],
        text=" ".join(t for _, t in parts)[:MAX_TEXT],
        seconds=round(seconds, 2),
        # Wall-clock-equivalent: the lines rendered one after another, so the
        # request's factor is the total audio over the total synthesis time,
        # never an average of the per-line factors.
        rtf=round(seconds / synth_seconds, 3) if synth_seconds > 0 else 0.0,
        segments=segments[:MAX_SEGMENTS],
        parent_id=take_id,
        derived_from={"kind": "public-reperform"},
        allow_reperform=False,
    )
    # Off the event loop: writing the wav and globbing the store to evict are
    # both blocking, and this handler is async because the render is.
    await asyncio.to_thread(_write_take, record, audio)
    return {
        "take_id": record["id"], "parent_id": take_id,
        "seconds": record["seconds"],
        "voices": voices,
        "single_voice": single_voice,
        # Said out loud whenever the result is one voice for a reason the
        # visitor could not see: the parent recorded no cast, so there was
        # never more than one voice available to perform with.
        "notice": (
            f"This take names no per-line cast, so the whole re-performance "
            f"was rendered in one voice ({names[0]}). If the original had more "
            f"than one speaker, that is not preserved."
            if single_voice and not cast else None
        ),
    }


def _reperform_parts(req: ReperformReq, parent: dict,
                     cast: dict[str, str]) -> list[tuple[str, str]]:
    """(character_id, text) per line to render, or a NAMED refusal.

    The two request forms are mutually exclusive, and the compute cap is
    enforced over the SUM of the lines — a cast re-perform of 1000 characters
    costs this box what a single-voice one of 1000 characters costs.

    A line may only name a Character the PARENT take cast. The publisher
    consented to THIS take being re-performed; accepting an arbitrary
    character_id would turn that into consent to put a visitor's words into any
    voice the deployment hosts, which is not a thing they were asked.
    """
    lines = [(l.character_id.strip(), l.text.strip()) for l in req.lines]
    lines = [(cid, text) for cid, text in lines if text]
    text = req.text.strip()

    if lines and text:
        raise HTTPException(
            400, "ambiguous: send either 'text' (one voice) or 'lines' (a "
                 "cast), not both")
    if not lines and not text:
        raise HTTPException(400, "empty: there is nothing to perform")

    if lines:
        if not cast:
            raise HTTPException(
                409, "cast-absent: this take records no per-line cast, so it "
                     "can only be re-performed as one voice — send 'text'")
        unknown = [cid for cid, _ in lines if cid not in cast]
        if unknown:
            raise HTTPException(
                403, f"cast-mismatch: '{unknown[0][:100]}' is not one of this "
                     f"take's Characters; a re-perform may only use the cast "
                     f"the publisher already put in it")
        parts = lines
    else:
        character_id = str(parent.get("character_id") or "")
        if not character_id:
            raise HTTPException(
                409, "character-absent: this take does not name a Character to "
                     "perform with")
        parts = [(character_id, text)]

    total = sum(len(t) for _, t in parts)
    if total > MAX_REPERFORM_TEXT:
        raise HTTPException(
            413, f"too-long: a public re-perform is capped at "
                 f"{MAX_REPERFORM_TEXT} characters ({total} sent)")
    return parts


# ── review sets (client approval loop) ────────────────────────────────────────
class ReviewReq(BaseModel):
    title: str = Field("", max_length=140)
    take_ids: list[str] = Field(..., min_length=2, max_length=6)


class PickReq(BaseModel):
    take_id: str
    reviewer: str = Field("", max_length=80)
    note: str = Field("", max_length=500)


class ReviseReq(BaseModel):
    """A reviewer asking for a change instead of ending the conversation."""
    note: str = Field(..., min_length=1, max_length=500)
    reviewer: str = Field("", max_length=80)
    direction: str = Field("", max_length=200)  # e.g. "line 3: baseline -> angry"


def _review_path(review_id: str) -> Path:
    return REVIEWS_DIR / f"{review_id}.json"


def _load_review(review_id: str) -> dict:
    p = _review_path(review_id)
    if not review_id.isalnum() or not p.is_file():
        raise HTTPException(404, "review not found (links are evicted oldest-first)")
    return json.loads(p.read_text("utf-8"))


@reviews_router.post("", status_code=201)
def create_review(req: ReviewReq) -> dict:
    """Bundle takes of the same script into one shareable approval link."""
    takes: list[dict] = []
    for tid in req.take_ids:
        p = TAKES_DIR / f"{tid}.json"
        if not tid.isalnum() or not p.is_file():
            raise HTTPException(404, f"take '{tid}' not found — share it first")
        takes.append(json.loads(p.read_text("utf-8")))

    review_id = uuid.uuid4().hex[:10]
    record = {
        "id": review_id,
        "title": req.title.strip() or "Pick a take",
        # the script is shared across takes by construction; keep the first
        "script": takes[0].get("text", ""),
        "take_ids": [t["id"] for t in takes],
        "created": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "pick": None,  # {take_id, reviewer, note, picked_at}
    }
    with file_lock(_reviews_lock()):
        _evict_reviews()
        atomic_write_text(_review_path(review_id), json.dumps(record))
    return {"review_id": review_id}


def _evict_reviews() -> None:
    REVIEWS_DIR.mkdir(parents=True, exist_ok=True)
    metas = sorted(REVIEWS_DIR.glob("*.json"), key=lambda p: p.stat().st_mtime)
    for old in metas[: max(0, len(metas) - MAX_REVIEWS + 1)]:
        old.unlink(missing_ok=True)
        old.with_suffix(".pick").unlink(missing_ok=True)  # drop its decision sentinel


def _revisions_of(review_id: str) -> list[dict]:
    """Later rounds seeded from this one. Derived by scanning the (capped)
    review store rather than by writing a pointer back into a DECIDED review —
    a recorded decision is never rewritten, which is what makes 'first pick is
    final' a property of the file and not just of the handler."""
    out: list[dict] = []
    if not REVIEWS_DIR.is_dir():
        return out
    for path in REVIEWS_DIR.glob("*.json"):
        try:
            other = json.loads(path.read_text("utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if not isinstance(other, dict):
            continue
        src = other.get("derived_from") or {}
        if isinstance(src, dict) and src.get("review_id") == review_id:
            out.append({
                "id": other.get("id", ""),
                "title": other.get("title", ""),
                "round": int(other.get("round", 1) or 1),
                "created": other.get("created", ""),
                "decided": bool(other.get("pick")),
            })
    out.sort(key=lambda r: r["created"])
    return out


@reviews_router.get("/preferred")
def preferred() -> dict:
    """What clients actually pick — the studio's default voice recommendation.
    Most-picked character wins; ties break toward the most recent pick."""
    counts: dict[str, int] = {}
    latest: dict | None = None
    if REVIEWS_DIR.is_dir():
        for p in sorted(REVIEWS_DIR.glob("*.json"), key=lambda p: p.stat().st_mtime):
            try:
                r = json.loads(p.read_text("utf-8"))
            except json.JSONDecodeError:
                continue
            pick = r.get("pick")
            if not pick:
                continue
            cid = pick.get("character_id")
            if cid:
                counts[cid] = counts.get(cid, 0) + 1
                latest = pick
    if not counts:
        return {"character_id": None, "picks": 0, "counts": {}}
    top = max(counts, key=lambda c: (counts[c], c == (latest or {}).get("character_id")))
    return {"character_id": top, "picks": counts[top], "counts": counts,
            "latest": latest}


@reviews_router.get("/{review_id}")
def get_review(review_id: str) -> dict:
    review = _load_review(review_id)
    takes = []
    for tid in review["take_ids"]:
        p = TAKES_DIR / f"{tid}.json"
        if p.is_file():  # a take may have been evicted from the bounded store
            takes.append(json.loads(p.read_text("utf-8")))
    return {**review, "takes": takes, "revisions": _revisions_of(review_id)}


@reviews_router.post("/{review_id}/revise", status_code=201)
def revise_review(review_id: str, req: ReviseReq) -> dict:
    """Ask for a change: a NEW review round, seeded from the picked take.

    The shipped invariant is "first pick is final — a new round is a new link".
    Revision keeps it exactly: the decided review is not touched, and the note
    plus the requested direction open a fresh round whose only starting take is
    the one the client already approved. What used to be an email round trip
    ("close, but make line 3 angrier") is now a link, and the requested change
    rides in `derived_from` where the studio — and direction.py, once the
    re-render is published as a child take — can read it.
    """
    # The whole round is decided INSIDE the store lock: the decision this
    # revision quotes is read, the store is evicted to make room, and the new
    # round is written, with no window in which another replica can evict the
    # source review out from under the round that cites it or race this
    # eviction with its own. The lock is the store's, not this review's —
    # eviction is what makes every writer here a writer of everyone's files.
    with file_lock(_reviews_lock()):
        return _revise_locked(review_id, req)


def _revise_locked(review_id: str, req: ReviseReq) -> dict:
    review = _load_review(review_id)
    pick = review.get("pick")
    if not pick:
        raise HTTPException(409, "pick a take first — a revision revises a decision")

    seed = str(pick.get("take_id", ""))
    if not _valid_id(seed):
        raise HTTPException(409, "this review's decision names no take to revise")

    round_no = int(review.get("round", 1) or 1) + 1
    base_title = str(review.get("title_base") or review.get("title") or "Pick a take")
    new_id = uuid.uuid4().hex[:10]
    record = {
        "id": new_id,
        "title": f"{base_title[:120]} - round {round_no}",
        "title_base": base_title[:120],
        "round": round_no,
        "script": review.get("script", ""),
        "take_ids": [seed],
        "created": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "pick": None,
        "derived_from": {
            "review_id": review_id,
            "take_id": seed,
            "note": req.note.strip()[:500],
            "direction": req.direction.strip()[:200],
            "reviewer": req.reviewer.strip()[:80],
        },
    }
    _evict_reviews()
    atomic_write_text(_review_path(new_id), json.dumps(record))
    return {"review_id": new_id, "round": round_no}


@reviews_router.post("/{review_id}/pick")
def pick_take(review_id: str, req: PickReq) -> dict:
    """The client's decision. First pick wins — a decided review is final
    (re-opening an approval is a new link, not an edit)."""
    review = _load_review(review_id)
    if review.get("pick"):
        raise HTTPException(409, "this review has already been decided")
    if req.take_id not in review["take_ids"]:
        raise HTTPException(400, "that take is not part of this review")

    take_meta = TAKES_DIR / f"{req.take_id}.json"
    character_id = ""
    if take_meta.is_file():
        character_id = json.loads(take_meta.read_text("utf-8")).get("character_id", "")

    pick = {
        "take_id": req.take_id,
        "character_id": character_id,
        "reviewer": req.reviewer.strip()[:80],
        "note": req.note.strip()[:500],
        "picked_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }

    # First pick wins ATOMICALLY across threads AND replica processes: the read
    # check above is only a fast reject, and two near-simultaneous picks would
    # both pass it and the second write would clobber the first. The winner is
    # whoever creates the .pick sentinel with O_CREAT|O_EXCL (an atomic
    # create-if-absent); everyone else gets a clean 409.
    lock = REVIEWS_DIR / f"{review_id}.pick"
    try:
        os.close(os.open(str(lock), os.O_CREAT | os.O_EXCL | os.O_WRONLY))
    except FileExistsError:
        raise HTTPException(409, "this review has already been decided")
    try:
        review["pick"] = pick
        # Atomic: the sentinel above already named the winner, so this write
        # must not be able to leave the decision half-recorded — a torn review
        # is unreadable, and its `.pick` sentinel would refuse every retry.
        atomic_write_text(_review_path(review_id), json.dumps(review))
    except Exception:
        lock.unlink(missing_ok=True)  # let a transient write failure be retried
        raise
    return pick
