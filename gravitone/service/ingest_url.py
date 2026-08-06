"""A pasted link becomes the same audio file a drop would have been.

The whole point of this module is that it stops at the *file*. It fetches the
AUDIO-ONLY stream behind a URL into a job's work dir and hands back a path;
everything downstream — `validate_upload_bytes`, `probe_duration`,
`ingest.analyze`, the speaker board, the commit — is the upload path, untouched.

Three constraints shaped it:

**No new decoder.** yt-dlp is invoked with NO postprocessors: one audio itag is
downloaded and written as-is (opus/webm 251 or aac/m4a 140), both of which
`ingest_api._AUDIO_EXTS` already accepts and ffmpeg already reads. Nothing here
adds a second copy of a media library to the image. (ffmpeg itself is already a
hard runtime dependency — `ingest.clean_audio`, `ingest.to_wav` and
`ingest_api.probe_duration` all shell out to it — so *using* it is free; adding
a decoder would not be. See `build_download_cmd` for the flags that keep the
downloader out of ffmpeg's way, and `trim_to` for the one place we call it on
purpose.)

**SSRF is not optional.** A URL the user pastes makes THIS box open a
connection. The security primitives are `narrate`'s — `host_allowed` (exact or
leading-dot suffix rules) and `check_public_ip` (refuses private, loopback,
link-local, CGNAT, and 169.254.169.254) — reused rather than re-derived, so a
future hardening of either lands here too. What is NOT reused is narrate's
copy: its refusals end in "paste the text instead", which is nonsense advice on
this screen. So the messages are authored here and the checks are imported.

Known and accepted limit, inherited from `narrate.fetch_url`: yt-dlp does its
own connecting, so DNS is resolved once by us and again by it. A rebinding
attacker who already controls a host on the YouTube allowlist could win that
race. The allowlist is the primary control precisely because it is not subject
to it.

**yt-dlp is brittle by nature.** It tracks a site that changes weekly, so it is
PINNED (requirements.txt) and its failures are treated as expected weather, not
as a 500: every one of them is a `LinkRefusal` carrying copy that names the
file-drop fallback. Raw yt-dlp stderr is logged, never returned — see
`service/errors.py`.
"""
from __future__ import annotations

import json
import logging
import os
import socket
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit

from service.narrate import check_public_ip, host_allowed

logger = logging.getLogger("gravitone")

#: Said at the end of every refusal. A link that cannot be read is not a dead
#: end — the dropzone is two inches away and always works.
DROP_INSTEAD = "download the audio and drop the file instead"

#: YouTube only, on purpose. This is an allowlist, not a filter: the feature is
#: "paste a YouTube link", and every host outside it is refused before DNS is
#: touched. `.youtube.com` (leading dot) matches www./m./music. and NOT the
#: apex, which is listed separately — `narrate.host_allowed`'s rule.
YOUTUBE_HOSTS = ["youtube.com", ".youtube.com", "youtu.be", ".youtu.be"]

#: The attestation a link-sourced job must carry. "I own this voice" is FALSE
#: for a video someone else published, and a consent receipt that records a
#: false sentence is worse than none: it launders the claim. This is the
#: honest one, and `ingest_api.commit_job` requires it verbatim for these jobs.
#: Mirrored in web/lib/consent.ts (EXTERNAL_CONSENT_STATEMENT).
EXTERNAL_STATEMENT = (
    "I have the right to use this recording and to clone the voice in it.")

#: Wall-clock ceilings. The probe is metadata-only and must feel like typing;
#: the download is bounded so a stalled connection cannot hold an admission
#: permit (and a phase thread) forever.
PROBE_TIMEOUT_S = float(os.environ.get("INGEST_LINK_PROBE_TIMEOUT", "") or 25)
DOWNLOAD_TIMEOUT_S = float(os.environ.get("INGEST_LINK_TIMEOUT", "") or 180)

#: How often the download watchdog weighs what has landed on disk.
_WATCH_INTERVAL_S = 0.25

#: Basename yt-dlp writes into the work dir (extension is the itag's own).
STEM = "link-src"


class LinkRefusal(Exception):
    """A named refusal with the status the caller should see.

    Same shape as `narrate.NarrateRefusal`, and for the same reason: "that host
    is not YouTube" (403) and "that video is longer than we can clone" (413)
    are different facts, and a flattened 400 helps nobody.
    """

    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


# ── URL validation ────────────────────────────────────────────────────────────

def guard_link(url: str) -> str:
    """Validate one pasted URL. Returns it unchanged, or raises `LinkRefusal`.

    Order matters and mirrors `narrate.guard_url`: scheme, then the ALLOWLIST,
    then DNS — so a caller can never use this endpoint to make the service
    resolve an arbitrary name. Every resolved address is checked, not the first:
    a host answering with one public and one private A record must not be
    ingestable on a coin flip.
    """
    raw = (url or "").strip()
    if not raw:
        raise LinkRefusal(400, f"paste a YouTube link first, or {DROP_INSTEAD}.")
    parts = urlsplit(raw)
    if parts.scheme not in ("http", "https"):
        named = parts.scheme or "a scheme-less URL"
        raise LinkRefusal(400, (
            f"only http and https links can be fetched, not '{named}' — "
            f"{DROP_INSTEAD}."))
    host = (parts.hostname or "").lower()
    if not host:
        raise LinkRefusal(400, f"that URL names no host — {DROP_INSTEAD}.")
    if not host_allowed(host, YOUTUBE_HOSTS):
        raise LinkRefusal(403, (
            f"'{host}' is not a YouTube link — this box only fetches from "
            f"youtube.com and youtu.be. {DROP_INSTEAD.capitalize()}."))
    port = parts.port or (443 if parts.scheme == "https" else 80)
    try:
        infos = socket.getaddrinfo(host, port, proto=socket.IPPROTO_TCP)
    except OSError:
        raise LinkRefusal(400, (
            f"'{host}' could not be resolved from this machine — check the "
            f"network, or {DROP_INSTEAD}."))
    if not infos:
        raise LinkRefusal(400, (
            f"'{host}' resolved to no addresses — {DROP_INSTEAD}."))
    for info in infos:
        try:
            check_public_ip(info[4][0])
        except Exception:
            # narrate's refusal names its own endpoint; the FACT (this host is
            # not on the public internet) is what we keep.
            raise LinkRefusal(403, (
                f"'{host}' resolves to an address that is not on the public "
                f"internet, so this box will not fetch it. {DROP_INSTEAD.capitalize()}."))
    return raw


# ── the yt-dlp seam ───────────────────────────────────────────────────────────
#
# Both entry points shell out to `python -m yt_dlp` rather than importing it:
# the import pulls a large module tree into every worker process, and — the
# reason that matters here — a subprocess is a boundary a test can stand in
# front of without a network. Tests replace `_run` / `_popen`.

_run = subprocess.run
_popen = subprocess.Popen


def _ytdlp_base() -> list[str]:
    return [sys.executable, "-m", "yt_dlp", "--no-playlist", "--no-warnings",
            "--no-progress", "--socket-timeout", "20"]


def build_download_cmd(url: str, dest: Path, *, max_bytes: int,
                       trim_seconds: float | None = None) -> list[str]:
    """The download argv, built where a test can read it.

    What is deliberately ABSENT is the contract: no `-x`/`--extract-audio`, no
    `--audio-format`, no `--recode-video`, no `--embed-*`, no `--merge-output-
    format`. Every one of those would hand the file to ffmpeg for a transcode
    we do not need — we want the itag's own bytes, because ingest's first move
    is to run its own ffmpeg pass anyway.

    `-f bestaudio[ext=m4a]/bestaudio` asks for a single audio-only stream, so
    there is nothing to mux either: m4a/aac (140) when offered, otherwise
    whatever audio-only stream is best (usually opus/webm 251). Both extensions
    are already in `ingest_api._AUDIO_EXTS`.

    """
    cmd = _ytdlp_base() + [
        "-f", "bestaudio[ext=m4a]/bestaudio",
        "--max-filesize", str(int(max_bytes)),
        "--no-part", "--no-continue", "--no-mtime",
        "-o", str(dest / f"{STEM}.%(ext)s"),
    ]
    if trim_seconds is not None:
        cmd += ["--download-sections", f"*0-{int(trim_seconds)}"]
    cmd.append(url)
    return cmd


@dataclass(frozen=True)
class LinkInfo:
    """What the metadata probe learned. `duration` is None when the extractor
    did not state one — which is a REFUSAL upstream, not a shrug: an unknown
    length is exactly the case the duration cap exists for."""
    title: str
    duration: float | None
    uploader: str | None
    is_live: bool


def probe(url: str, *, timeout: float | None = None) -> LinkInfo:
    """Metadata only — `--skip-download`, no media transferred.

    This is the whole of Direction 2's "honest limits at the door": the verdict
    (fits / will be trimmed / cannot be read) is reachable at paste time, for
    the cost of one JSON call, instead of after a two-minute download.
    """
    cmd = _ytdlp_base() + ["-J", "--skip-download", url]
    try:
        r = _run(cmd, capture_output=True, timeout=timeout or PROBE_TIMEOUT_S)
    except subprocess.TimeoutExpired:
        raise LinkRefusal(504, (
            "that link took too long to read — try again, or "
            f"{DROP_INSTEAD}."))
    except OSError as exc:
        logger.error("link probe could not start yt-dlp: %s", exc)
        raise LinkRefusal(503, (
            "this deployment cannot read links right now (the extractor is "
            f"missing). {DROP_INSTEAD.capitalize()}."))
    if r.returncode != 0:
        _log_ytdlp("probe", url, r.stderr)
        raise LinkRefusal(422, _extractor_message(r.stderr))
    try:
        meta = json.loads((r.stdout or b"").decode("utf-8", "replace")
                          if isinstance(r.stdout, bytes) else (r.stdout or ""))
    except (ValueError, AttributeError):
        _log_ytdlp("probe-parse", url, r.stdout)
        raise LinkRefusal(422, (
            f"couldn't read that link's details. {DROP_INSTEAD.capitalize()}."))
    if not isinstance(meta, dict):
        raise LinkRefusal(422, f"couldn't read that link. {DROP_INSTEAD.capitalize()}.")
    # NON-GOAL, stated rather than half-handled: playlists and live streams.
    if meta.get("_type") == "playlist" or "entries" in meta:
        raise LinkRefusal(422, (
            "that link is a playlist — paste a single video's link."))
    live = bool(meta.get("is_live")) or meta.get("live_status") in ("is_live", "post_live")
    if live:
        raise LinkRefusal(422, (
            "that is a live stream — it has no fixed length to clone from. "
            "Paste a finished video."))
    dur = meta.get("duration")
    try:
        duration = float(dur) if dur is not None else None
    except (TypeError, ValueError):
        duration = None
    return LinkInfo(title=str(meta.get("title") or "").strip() or "this video",
                    duration=duration,
                    uploader=(str(meta.get("uploader")).strip()
                              if meta.get("uploader") else None),
                    is_live=False)


def download(url: str, dest: Path, *, max_bytes: int,
             trim_seconds: float | None = None,
             timeout: float | None = None) -> Path:
    """Fetch the audio stream into `dest`; return the file written.

    The byte ceiling is enforced TWICE and neither check trusts the server:
    `--max-filesize` refuses on the declared size (cheap, and stops the
    transfer before it starts), and a watchdog weighs the work dir every
    quarter-second and kills the process the moment what has actually landed
    exceeds the cap. A lying Content-Length buys an attacker a quarter of a
    second of disk — the same stance as narrate's read of one byte past the cap.
    """
    dest.mkdir(parents=True, exist_ok=True)
    cmd = build_download_cmd(url, dest, max_bytes=max_bytes,
                             trim_seconds=trim_seconds)
    errfile = dest / "ytdlp.stderr"
    deadline = time.monotonic() + (timeout or DOWNLOAD_TIMEOUT_S)
    try:
        with errfile.open("wb") as err:
            proc = _popen(cmd, stdout=subprocess.DEVNULL, stderr=err)
            try:
                while proc.poll() is None:
                    if _written_bytes(dest) > max_bytes:
                        _kill(proc)
                        raise LinkRefusal(413, _too_big(max_bytes))
                    if time.monotonic() > deadline:
                        _kill(proc)
                        raise LinkRefusal(504, (
                            "that download took too long and was stopped — "
                            f"{DROP_INSTEAD}."))
                    time.sleep(_WATCH_INTERVAL_S)
            finally:
                if proc.poll() is None:
                    _kill(proc)
    except OSError as exc:
        logger.error("link download could not start yt-dlp: %s", exc)
        raise LinkRefusal(503, (
            "this deployment cannot fetch links right now (the extractor is "
            f"missing). {DROP_INSTEAD.capitalize()}."))
    stderr = _read_tail(errfile)
    errfile.unlink(missing_ok=True)

    written = _media_files(dest)
    if proc.returncode != 0 or not written:
        _cleanup(written)
        _log_ytdlp("download", url, stderr)
        # `--max-filesize` aborts with a non-zero exit and this phrase; it is
        # a cap refusal, not a broken link, and must not read as one.
        if "larger than max-filesize" in (stderr or "").lower():
            raise LinkRefusal(413, _too_big(max_bytes))
        raise LinkRefusal(422, _extractor_message(stderr))
    if len(written) > 1:
        # One audio itag, one file. More than that means a format selection we
        # did not ask for (a mux), and muxing is exactly what we forbid.
        _cleanup(written)
        raise LinkRefusal(422, (
            "that link produced more than one media file, which this box does "
            f"not merge. {DROP_INSTEAD.capitalize()}."))
    src = written[0]
    if src.stat().st_size > max_bytes:
        src.unlink(missing_ok=True)
        raise LinkRefusal(413, _too_big(max_bytes))
    if src.stat().st_size == 0:
        src.unlink(missing_ok=True)
        raise LinkRefusal(422, (
            f"that link produced an empty file. {DROP_INSTEAD.capitalize()}."))
    return src


def trim_to(src: Path, seconds: float) -> Path:
    """Cut `src` down to its first `seconds` with the ffmpeg already on PATH.

    The BACKSTOP, not the plan: `--download-sections` normally means the long
    tail is never transferred at all. This runs when the delivered file is
    still over the ceiling anyway (an extractor that ignored the section, a
    keyframe landing late), because "the trimmed duration is what analyze
    receives" has to be a fact about the file, not a hope about a flag.

    Stream copy first — no re-encode, no quality loss, and no decoder beyond
    the ffmpeg the pipeline already requires. A container that refuses a copy
    cut falls back to a re-encode into WAV, which ingest converts to anyway.
    """
    cut = src.with_name(f"{src.stem}-trimmed{src.suffix}")
    copy_cmd = ["ffmpeg", "-y", "-v", "error", "-t", f"{seconds:.3f}",
                "-i", str(src), "-c", "copy", str(cut)]
    try:
        r = _run(copy_cmd, capture_output=True, timeout=120)
        if r.returncode != 0 or not cut.exists() or cut.stat().st_size == 0:
            cut.unlink(missing_ok=True)
            cut = src.with_name(f"{src.stem}-trimmed.wav")
            r = _run(["ffmpeg", "-y", "-v", "error", "-t", f"{seconds:.3f}",
                      "-i", str(src), "-ac", "1", str(cut)],
                     capture_output=True, timeout=300)
    except (OSError, subprocess.TimeoutExpired) as exc:
        cut.unlink(missing_ok=True)
        logger.error("link trim failed for %s: %s", src.name, exc)
        raise LinkRefusal(500, (
            "couldn't trim that recording to a clonable length — "
            f"{DROP_INSTEAD}."))
    if r.returncode != 0 or not cut.exists() or cut.stat().st_size == 0:
        cut.unlink(missing_ok=True)
        _log_ytdlp("trim", str(src), getattr(r, "stderr", b""))
        raise LinkRefusal(500, (
            "couldn't trim that recording to a clonable length — "
            f"{DROP_INSTEAD}."))
    src.unlink(missing_ok=True)
    return cut


# ── verdicts ──────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class Verdict:
    """What we will do with this link, decided BEFORE any media moves."""
    ok: bool
    title: str
    duration: float | None
    #: seconds we will actually clone from (== duration when nothing is cut)
    clip_seconds: float | None
    trimmed: bool
    #: one sentence, written for the paste box
    message: str


def verdict(info: LinkInfo, *, min_seconds: float, max_seconds: float) -> Verdict:
    """Turn probe metadata into the sentence the paste box shows.

    TRIM, not reject, for a long video: a 47-minute interview is a perfectly
    good source of one voice, and the first quarter-hour of it is more than the
    pipeline needs. Rejecting would be defensible for a file the user chose to
    upload — they can trim that themselves — but a link is not something the
    user can edit, so "we'll clone the first 15 minutes" is the only answer
    that leaves them with a voice. The cut is stated at paste time; it never
    happens silently.

    A video too SHORT is still a refusal: there is no honest way to invent
    speech that is not there.
    """
    if info.duration is None:
        return Verdict(False, info.title, None, None, False, (
            f"couldn't read how long that video is, so it can't be cloned "
            f"safely. {DROP_INSTEAD.capitalize()}."))
    if info.duration < min_seconds:
        return Verdict(False, info.title, info.duration, None, False, (
            f"that video is {_human(info.duration)} long — a clone needs at "
            f"least {min_seconds:.0f} seconds of speech."))
    if info.duration > max_seconds:
        return Verdict(True, info.title, info.duration, max_seconds, True, (
            f"{_human(info.duration)} video — we'll clone the first "
            f"{_human(max_seconds)}."))
    return Verdict(True, info.title, info.duration, info.duration, False, (
        f"{_human(info.duration)} of audio — that fits, nothing will be cut."))


def _human(seconds: float) -> str:
    """Durations as a person says them: seconds, then minutes, then hours."""
    if seconds < 90:
        return f"{seconds:.0f} seconds"
    mins = seconds / 60
    if mins < 90:
        return f"{mins:.0f} minutes"
    return f"{mins / 60:.1f} hours"


# ── plumbing ──────────────────────────────────────────────────────────────────

def _too_big(max_bytes: int) -> str:
    return (f"that video's audio is over the {max_bytes // (1024 * 1024)} MB "
            f"ceiling this box will fetch. {DROP_INSTEAD.capitalize()}.")


def _media_files(dest: Path) -> list[Path]:
    return sorted(p for p in dest.glob(f"{STEM}.*")
                  if p.is_file() and p.suffix != ".stderr")


def _written_bytes(dest: Path) -> int:
    total = 0
    for p in dest.glob(f"{STEM}*"):
        try:
            total += p.stat().st_size
        except OSError:
            pass
    return total


def _cleanup(paths: list[Path]) -> None:
    for p in paths:
        p.unlink(missing_ok=True)


def _kill(proc) -> None:  # noqa: ANN001 - Popen or a test double
    try:
        proc.kill()
    except OSError:
        pass
    try:
        proc.wait(timeout=5)
    except Exception:  # noqa: BLE001 - a wedged child must not wedge the route
        pass


def _read_tail(path: Path, limit: int = 2000) -> str:
    try:
        return path.read_bytes()[-limit:].decode("utf-8", "replace")
    except OSError:
        return ""


def _log_ytdlp(stage: str, url: str, raw) -> None:  # noqa: ANN001
    """The raw extractor output goes to the LOG and stops there.

    Same discipline as `errors.sanitized_500`: yt-dlp stderr routinely carries
    absolute paths, cookie-file locations and the operator's IP as seen by
    YouTube. None of that belongs in a response body.
    """
    if isinstance(raw, bytes):
        raw = raw.decode("utf-8", "replace")
    logger.warning("yt-dlp %s failed for %s: %s", stage, url,
                   (raw or "")[-600:].strip() or "(no output)")


#: Extractor failures a user can act on, mapped to copy that says what to do.
#: Matched against yt-dlp's own stderr — which is why the match is a substring
#: on stable phrases, and why the DEFAULT is a generic sentence rather than the
#: raw text: an unrecognised failure must degrade to honest vagueness, never to
#: a leak.
_KNOWN = (
    ("private video", "that video is private."),
    ("sign in to confirm your age", "that video is age-restricted, so this box cannot read it."),
    ("members-only", "that video is members-only."),
    ("video unavailable", "that video is unavailable."),
    ("is not available", "that video is not available."),
    ("removed by the uploader", "that video was removed by its uploader."),
    ("copyright", "that video is blocked on copyright grounds."),
    ("sign in to confirm", "YouTube is asking this box to sign in, which it will not do."),
    ("unsupported url", "that link is not a video this box can read."),
    ("no video formats", "that link has no audio stream to fetch."),
    ("requested format is not available", "that link has no audio-only stream to fetch."),
    ("live event will begin", "that video has not started yet."),
)


def _extractor_message(stderr) -> str:  # noqa: ANN001
    low = (stderr.decode("utf-8", "replace") if isinstance(stderr, bytes)
           else (stderr or "")).lower()
    for needle, sentence in _KNOWN:
        if needle in low:
            return f"{sentence} {DROP_INSTEAD.capitalize()}."
    return (f"couldn't get audio from that link. {DROP_INSTEAD.capitalize()}.")
