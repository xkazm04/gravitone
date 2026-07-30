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
"""
from __future__ import annotations

import json
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from service import direction
from service.config import SETTINGS

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
@router.post("", status_code=201)
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

    take_id = uuid.uuid4().hex[:10]
    record = {
        "id": take_id,
        "character_id": str(m.get("character_id", ""))[:100],
        "character_name": str(m.get("character_name", "Character"))[:100],
        "text": text,
        "seconds": float(m.get("seconds", 0) or 0),
        "rtf": float(m.get("rtf", 0) or 0),
        "segments": [
            {
                "text": str(s.get("text", ""))[:300],
                "requested": str(s.get("requested", "baseline"))[:32],
                "used": str(s.get("used", "baseline"))[:32],
                "fallback": bool(s.get("fallback", False)),
                "seconds": float(s.get("seconds", 0) or 0),
            }
            for s in segments
        ],
        "created": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "parent_id": parent_id or None,
        "derived_from": _clean_derived_from(m.get("derived_from")) or None,
    }

    TAKES_DIR.mkdir(parents=True, exist_ok=True)
    _evict_oldest()
    (TAKES_DIR / f"{take_id}.wav").write_bytes(audio)
    (TAKES_DIR / f"{take_id}.json").write_text(json.dumps(record), "utf-8")

    # The diff between parent and child is a human direction decision. Counted
    # after the take is safely on disk, and never able to fail it.
    if parent_id:
        parent_meta = _read_meta(parent_id)
        if parent_meta is not None:
            direction.record_delta(parent_meta, record)
    return {"take_id": take_id}


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
    _evict_reviews()
    _review_path(review_id).write_text(json.dumps(record), "utf-8")
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
    _review_path(new_id).write_text(json.dumps(record), "utf-8")
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
        _review_path(review_id).write_text(json.dumps(review), "utf-8")
    except Exception:
        lock.unlink(missing_ok=True)  # let a transient write failure be retried
        raise
    return pick
