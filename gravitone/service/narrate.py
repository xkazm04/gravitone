"""Audible Docs, generalised: any page -> a segmented narration PLAN.

The shell's own narration dock (web/components/ui/NarrationDock.tsx) reads a
registry that is DERIVED from the site's own content modules, so it can never
drift from the page. That trick does not travel: a customer's docs site has no
`lib/content.ts` for us to import. This module is the general case.

    POST /v1/narrate {url? | markdown? | html?}  -> a narration PLAN
    GET  /v1/narrate/{narration_id}              -> the same plan again

A PLAN is text, not audio. It names, in order, the blocks a narrator should
read, the emotion each block is addressed with, and the kind of Character each
block wants -- plus the EXACT existing route a client calls to turn one block
into sound. Nothing here synthesizes anything.

That is deliberate and it is the whole design:

  * There is one synthesis path in this service (``_render_tts`` behind
    ``/v1/text-to-speech`` and ``/v1/speak``). It owns admission, the cache, the
    digest law, the emotion fallback report. A second path that rendered whole
    pages would duplicate every one of those decisions and would be the first
    place they drift.
  * Pages are long. Pre-rendering one is minutes of engine time for audio a
    reader may abandon after two sentences. Blocks render LAZILY, one at a time,
    as the listener advances -- so a 40-block page costs exactly as much engine
    as it is actually listened to.
  * A plan is cheap enough to be free, small enough to cache, and stable enough
    to content-hash -- which is what lets `web/scripts/bake-narration.ts` render
    audio once at build time and serve it as static files forever after.

EXTRACTION is readability-lite and stdlib-only (`html.parser`): chrome is
dropped (script/style/nav/header/footer/aside/form/svg), headings and prose are
kept, a heading starts a new block. It is honest rather than clever, and when it
comes up empty the refusal SAYS SO and names the way out: paste the text
instead, as `markdown` or `html`. Extraction quality on third-party HTML is the
classic long tail; a fallback the caller can act on beats a scraper that lies.

SSRF. `url` is the dangerous field -- it asks this service to make an outbound
request chosen by a caller, from inside whatever network it runs in. So:

  * Remote fetching is OFF by default. `narrate_allow_hosts`
    (env ``NARRATE_ALLOW_HOSTS``, comma-separated) is empty unless an operator
    sets it, and empty means url is refused outright: markdown/html bodies only.
  * A host must MATCH the allowlist (exact, or a leading dot for a suffix).
  * Every IP the host resolves to must be globally routable. Loopback, private,
    link-local (169.254.0.0/16 -- the cloud metadata service), CGNAT, reserved
    and multicast are all refused by name.
  * Redirects are re-validated at every hop against the same two checks, and
    capped. A 302 to 169.254.169.254 is the classic bypass; here it is a refusal
    with the hop's host in the message.
  * Size and time are capped (``NARRATE_MAX_BYTES``, ``NARRATE_TIMEOUT_S``), and
    a non-text content type is refused before a single byte is parsed.

Every refusal above is a named sentence a human can act on -- never a bare 403.

The plan store is bounded (takes.py discipline): plans are a convenience for
"give me that id again", not an archive, and the oldest are evicted past the
cap.
"""
from __future__ import annotations

import ipaddress
import json
import re
import socket
import unicodedata
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlsplit

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from service.config import SETTINGS
from service.emotions import BASELINE, EMOTION_SCALE

router = APIRouter(prefix="/v1/narrate", tags=["narrate"])

# -- bounds -------------------------------------------------------------------

NARRATIONS_DIR = Path(SETTINGS.voices_dir).parent / "narrations"
MAX_NARRATIONS = 300        # plans kept on disk; oldest evicted (no lineage)
MAX_BODY_CHARS = 400_000    # an inline markdown/html body
MAX_BLOCKS = 200            # blocks in one plan
MAX_BLOCK_CHARS = 1200      # one block, before a new one is started
MAX_TEXT_CHARS = 120_000    # total spoken text in one plan
MAX_LABEL = 90
MAX_REDIRECTS = 3

#: Env-configured, because config.py is shared and this is a narrate-only dial.
#: ``NARRATE_ALLOW_HOSTS`` is comma-separated; an entry starting with "." matches
#: any subdomain (".example.com" allows docs.example.com but NOT example.com).
#: EMPTY IS THE DEFAULT and means: no remote fetching at all.
def _allow_hosts() -> list[str]:
    import os
    raw = os.environ.get("NARRATE_ALLOW_HOSTS", "")
    return [h.strip().lower() for h in raw.split(",") if h.strip()]


def _fetch_limits() -> tuple[int, float]:
    import os
    try:
        max_bytes = int(os.environ.get("NARRATE_MAX_BYTES", 1024 * 1024))
    except ValueError:
        max_bytes = 1024 * 1024
    try:
        timeout = float(os.environ.get("NARRATE_TIMEOUT_S", "8"))
    except ValueError:
        timeout = 8.0
    return max(1024, max_bytes), max(0.5, timeout)


class NarrateRefusal(Exception):
    """A named refusal. Carries the HTTP status the caller should see, because
    "this deployment does not fetch URLs" (403) and "that page was too big"
    (413) are different facts and flattening them helps nobody."""

    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


PASTE_INSTEAD = "paste the text instead: send it as `markdown` or `html`"


# -- the spoken normalisation -------------------------------------------------
#
# Mirrors web/lib/narratable.ts::speakable. Kept as an independent list rather
# than shared, because these are two runtimes and neither can import the other;
# what IS shared is the rule -- a symbol that reads fine and speaks badly gets
# replaced by the words it means, with the surrounding whitespace eaten so the
# replacement does not leave a detached comma the engine renders as a stumble.
# Written with escapes so this source file stays ASCII.
_SPOKEN: list[tuple[re.Pattern[str], str]] = [
    (re.compile("\\s*\u00d7\\s*"), " times "),      # multiplication sign
    (re.compile("\\s*\u00b7\\s*"), ", "),           # middle dot
    (re.compile("\\s*\u2192\\s*"), " then "),       # rightwards arrow
    (re.compile("\\s*\u221e\\s*"), " unlimited "),  # infinity
    (re.compile("\\s*\u2014\\s*"), " - "),          # em dash
    (re.compile(r"\baud/s\b"), "audio-seconds per second"),
    (re.compile(r"\bRTF\b"), "realtime factor"),
]


#: Typographic characters NFKC leaves alone (it decomposes ligatures and
#: width, not punctuation). Every CMS on earth emits these; folding them keeps
#: the spoken text -- and therefore its content hash -- identical whether the
#: same sentence arrived as markdown, as HTML entities, or as smart-quoted prose
#: from a word processor.
_TYPOGRAPHIC = str.maketrans({
    "\u2018": "'", "\u2019": "'", "\u201a": "'", "\u201b": "'",
    "\u201c": '"', "\u201d": '"', "\u201e": '"',
    "\u2013": " - ", "\u2026": "...", "\u00a0": " ", "\u200b": "",
    "\ufeff": "", "\u00ad": "",
})


def speakable(text: str) -> str:
    """Normalise one string into something a TTS engine can actually say."""
    out = unicodedata.normalize("NFKC", text or "").translate(_TYPOGRAPHIC)
    for pattern, replacement in _SPOKEN:
        out = pattern.sub(replacement, out)
    return re.sub(r"\s+", " ", out).strip()


def content_hash(text: str) -> str:
    """FNV-1a-ish, two 32-bit lanes, 16 hex chars.

    A DELIBERATE PORT of web/lib/narratable.ts::contentHash, arithmetic for
    arithmetic. It is not a security primitive and does not need to be -- it is
    a cache key, and the one property that matters is that the browser, the
    build-time bake script and this service all compute the SAME string for the
    same text, forever. A stronger hash that only two of the three could compute
    would be strictly worse. (Python's built-in `hash()` is unusable here for
    the same reason it is unusable for any persisted key: PYTHONHASHSEED
    randomises it per process.)
    """
    a = 0x811C9DC5
    b = 0x01000193
    # UTF-16 code UNITS, not code points: JS `charCodeAt` walks units, so an
    # emoji is two iterations there and would be one here. Prose rarely carries
    # astral characters, which is exactly why this divergence would have been
    # found by nobody until it silently mismatched one cached clip.
    units = text.encode("utf-16-le")
    for i in range(0, len(units), 2):
        code = units[i] | (units[i + 1] << 8)
        a = ((a ^ code) * 0x01000193) & 0xFFFFFFFF
        b = ((b ^ ((code + (i >> 1)) & 0xFFFFFFFF)) * 0x85EBCA6B) & 0xFFFFFFFF
    return f"{a:08x}{b:08x}"


#: ASCII unit separator. Joining fields with a SPACE would let ["a b", "c"] and
#: ["a", "b c"] hash identically, and a cache key that collides across fields is
#: a cache that plays the wrong audio. Same constant as the TS side.
SEPARATOR = "\x1f"


def hash_parts(*parts: str) -> str:
    return content_hash(SEPARATOR.join(parts))


def _stop(text: str) -> str:
    """A sentence-terminated fragment, so joined parts do not run together."""
    stripped = text.strip()
    if not stripped:
        return ""
    return stripped if stripped[-1] in ".!?:;" else stripped + "."


# -- extraction ---------------------------------------------------------------

#: Everything inside these is chrome, boilerplate or code -- never prose. The
#: parser drops the whole subtree, which is why `nav` full of links does not
#: become forty spoken link texts.
_SKIP_TAGS = frozenset({
    "script", "style", "noscript", "template", "svg", "math", "canvas",
    "nav", "header", "footer", "aside", "form", "button", "select", "textarea",
    "iframe", "object", "video", "audio", "figure", "figcaption", "picture",
})
_HEADINGS = frozenset({"h1", "h2", "h3", "h4", "h5", "h6"})
#: Block-level prose containers. A `td` is included because documentation
#: tables are prose in a grid often enough to be worth reading.
_PROSE_TAGS = frozenset({"p", "li", "blockquote", "dd", "dt", "td", "pre"})


class _Reader(HTMLParser):
    """Readability-lite. Not a general HTML5 parser and not trying to be.

    Two facts make this good enough: documentation pages put their prose in
    p/li/h* (that is what makes them documentation), and the failure mode of
    missing some is a shorter reading, not a wrong one. The failure mode we do
    care about -- reading the nav menu aloud -- is what `_SKIP_TAGS` prevents.
    """

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.pieces: list[tuple[str, str]] = []   # (kind, text)
        self.title = ""
        self._skip_depth = 0
        self._open: list[str] = []
        self._buffer: list[str] = []
        self._in_title = False

    # -- helpers ----------------------------------------------------------
    def _flush(self, kind: str) -> None:
        text = speakable("".join(self._buffer))
        self._buffer = []
        if len(text) < 2:
            return
        if len(self.pieces) < MAX_BLOCKS * 8:
            self.pieces.append((kind, text))

    # -- parser hooks -----------------------------------------------------
    def handle_starttag(self, tag: str, attrs) -> None:  # noqa: ANN001
        if self._skip_depth:
            # Nested skip tags must be counted, or the FIRST closing tag would
            # re-enable capture while still inside the outer <nav>.
            if tag in _SKIP_TAGS:
                self._skip_depth += 1
            return
        if tag in _SKIP_TAGS:
            self._skip_depth = 1
            return
        if tag == "title":
            self._in_title = True
            return
        if tag in _HEADINGS or tag in _PROSE_TAGS:
            # An unclosed previous block (very common in hand-written HTML)
            # must not swallow the next one.
            if self._open:
                self._flush(self._kind(self._open[-1]))
            self._open.append(tag)
        elif tag == "br":
            self._buffer.append(" ")

    def handle_endtag(self, tag: str) -> None:
        if self._skip_depth:
            if tag in _SKIP_TAGS:
                self._skip_depth -= 1
            return
        if tag == "title":
            self._in_title = False
            self.title = speakable("".join(self._buffer))[:MAX_LABEL]
            self._buffer = []
            return
        if self._open and self._open[-1] == tag:
            self._open.pop()
            self._flush(self._kind(tag))

    def handle_data(self, data: str) -> None:
        if self._skip_depth:
            return
        if self._in_title or self._open:
            self._buffer.append(data)

    def close(self) -> None:  # noqa: D102
        super().close()
        if self._open:
            self._flush(self._kind(self._open[-1]))

    @staticmethod
    def _kind(tag: str) -> str:
        if tag in _HEADINGS:
            return "heading"
        if tag == "blockquote":
            return "quote"
        if tag == "li":
            return "list"
        return "body"


def extract_html(html: str) -> tuple[str, list[tuple[str, str]]]:
    """(title, pieces) from an HTML document. Never raises on bad markup."""
    reader = _Reader()
    try:
        reader.feed(html)
        reader.close()
    except Exception:
        # html.parser is tolerant, but a pathological document should degrade
        # to "whatever we got before it broke", not to a 500.
        pass
    return reader.title, reader.pieces


_MD_FENCE = re.compile(r"^\s*(```|~~~)")
_MD_HEADING = re.compile(r"^\s{0,3}(#{1,6})\s+(.*)$")
_MD_BULLET = re.compile(r"^\s{0,3}([-*+]|\d{1,3}[.)])\s+")
_MD_IMAGE = re.compile(r"!\[[^\]]*\]\([^)]*\)")
_MD_LINK = re.compile(r"\[([^\]]*)\]\([^)]*\)")
_MD_INLINE = re.compile(r"[*_`~]{1,3}")
_MD_RULE = re.compile(r"^\s{0,3}([-*_])(\s*\1){2,}\s*$")


def extract_markdown(markdown: str) -> tuple[str, list[tuple[str, str]]]:
    """(title, pieces) from markdown, line by line.

    No markdown library: the subset that matters for narration is headings,
    paragraphs, lists and quotes, and everything else is decoration that should
    not be spoken anyway. Fenced code is DROPPED -- a narrator reading a shell
    snippet aloud is the single most annoying thing an audible-docs player can
    do.
    """
    title = ""
    pieces: list[tuple[str, str]] = []
    para: list[str] = []
    kind = "body"
    fenced = False

    def flush() -> None:
        nonlocal para, kind
        text = speakable(" ".join(para))
        para = []
        if len(text) >= 2 and len(pieces) < MAX_BLOCKS * 8:
            pieces.append((kind, text))
        kind = "body"

    for raw in markdown.splitlines():
        if _MD_FENCE.match(raw):
            flush()
            fenced = not fenced
            continue
        if fenced:
            continue
        line = raw.rstrip()
        if not line.strip() or _MD_RULE.match(line):
            flush()
            continue
        heading = _MD_HEADING.match(line)
        if heading:
            flush()
            text = speakable(_plain_md(heading.group(2)))
            if text:
                pieces.append(("heading", text))
                if not title and len(heading.group(1)) == 1:
                    title = text[:MAX_LABEL]
            continue
        bullet = _MD_BULLET.match(line)
        quoted = line.lstrip().startswith(">")
        if bullet or quoted:
            flush()
            kind = "list" if bullet else "quote"
            line = line.lstrip().lstrip(">").strip() if quoted else line[bullet.end():]
            para.append(_plain_md(line))
            flush()
            continue
        para.append(_plain_md(line))
    flush()
    return title, pieces


def _plain_md(text: str) -> str:
    out = _MD_IMAGE.sub("", text)
    out = _MD_LINK.sub(r"\1", out)      # the link TEXT is prose; the URL is not
    out = _MD_INLINE.sub("", out)
    return out


# -- blocks -------------------------------------------------------------------

#: role -> (emotion, character hint). The emotions are names from
#: ``EMOTION_SCALE``; a Character missing one falls back on the nearest and the
#: synthesis response says so in X-Emotion-Fallback -- that report is the
#: client's, not ours to pre-empt.
_ROLE: dict[str, tuple[str, str]] = {
    "lead": ("excited", "warm"),
    "heading": ("calm", "measured"),
    "body": (BASELINE, "measured"),
    "list": (BASELINE, "measured"),
    "quote": ("calm", "warm"),
}

for _emotion, _hint in _ROLE.values():
    assert _emotion in EMOTION_SCALE, f"{_emotion} is not on the emotion scale"


def build_blocks(pieces: list[tuple[str, str]]) -> list[dict]:
    """Group extracted pieces into the units a narrator reads.

    A heading starts a block and is spoken as its opening line, because that is
    how a person reads a document out loud: they announce the section, then read
    it. Prose accumulates until MAX_BLOCK_CHARS so no single block ties up a
    synth slot for a minute, and the FIRST block is the "lead" -- the one that
    gets the warm voice, because it is the one a listener decides on.
    """
    blocks: list[dict] = []
    label = ""
    role = "lead"
    parts: list[str] = []
    spoken_total = 0

    def emit() -> None:
        nonlocal parts, label, spoken_total
        text = speakable(" ".join(p for p in parts if p))
        parts = []
        if len(text) < 2 or len(blocks) >= MAX_BLOCKS:
            return
        if spoken_total + len(text) > MAX_TEXT_CHARS:
            return
        spoken_total += len(text)
        emotion, hint = _ROLE.get(role, _ROLE["body"])
        blocks.append({
            "id": f"b{len(blocks):03d}",
            "label": (label or text)[:MAX_LABEL],
            "text": text,
            "emotion": emotion,
            "character_hint": hint,
            "role": role,
        })

    for kind, text in pieces:
        if kind == "heading":
            emit()
            label = text[:MAX_LABEL]
            role = "lead" if not blocks else "heading"
            parts = [_stop(text)]
            continue
        if sum(len(p) for p in parts) + len(text) > MAX_BLOCK_CHARS:
            emit()
            role = "body" if blocks else "lead"
        if not parts and not label:
            role = "lead" if not blocks else kind
        parts.append(_stop(text) if kind in ("list", "heading") else text)
    emit()
    return blocks


# -- SSRF-guarded fetch -------------------------------------------------------

def host_allowed(host: str, allow: list[str]) -> bool:
    """Exact match, or a suffix entry written with a leading dot.

    ".example.com" allows docs.example.com and NOT example.com, on purpose: an
    operator who wants both writes both. A suffix rule that also matched the
    apex would silently widen every allowlist by one host.
    """
    h = (host or "").lower().strip(".")
    if not h:
        return False
    for entry in allow:
        if entry.startswith("."):
            if h.endswith(entry):
                return True
        elif h == entry:
            return True
    return False


def _refuse_ip(ip: str) -> str:
    return (f"that host resolves to {ip}, which is not a public address - "
            f"narration refuses private, loopback, link-local and reserved "
            f"targets. {PASTE_INSTEAD}")


def check_public_ip(raw: str) -> None:
    """Raise unless `raw` is a globally routable address.

    `is_global` is the check that matters (it covers loopback, RFC1918,
    169.254/16 -- the cloud metadata endpoint -- CGNAT, and the reserved
    ranges), but it is stated together with the explicit predicates below so
    that a future Python whose `is_global` changes shape still refuses the
    addresses this function exists to refuse.
    """
    try:
        ip = ipaddress.ip_address(raw)
    except ValueError:
        raise NarrateRefusal(403, f"that host resolved to something that is not "
                                  f"an IP address. {PASTE_INSTEAD}")
    if (ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved
            or ip.is_multicast or ip.is_unspecified or not ip.is_global):
        raise NarrateRefusal(403, _refuse_ip(str(ip)))


def guard_url(url: str, allow: list[str]) -> tuple[str, str]:
    """Validate one URL (or one redirect hop). Returns (host, port-as-str).

    Order matters: the ALLOWLIST is checked before DNS, so a caller cannot use
    this endpoint to make the service resolve arbitrary names.
    """
    if not allow:
        raise NarrateRefusal(403, (
            "this deployment does not fetch remote URLs - set NARRATE_ALLOW_HOSTS "
            f"to the hosts it may read. {PASTE_INSTEAD}"))
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https"):
        named = parts.scheme or "a scheme-less URL"
        raise NarrateRefusal(400, (
            f"only http and https URLs can be narrated, not '{named}'. "
            f"{PASTE_INSTEAD}"))
    host = (parts.hostname or "").lower()
    if not host:
        raise NarrateRefusal(400, f"that URL names no host. {PASTE_INSTEAD}")
    if not host_allowed(host, allow):
        raise NarrateRefusal(403, (
            f"'{host}' is not in NARRATE_ALLOW_HOSTS on this deployment. "
            f"{PASTE_INSTEAD}"))
    port = parts.port or (443 if parts.scheme == "https" else 80)
    try:
        infos = socket.getaddrinfo(host, port, proto=socket.IPPROTO_TCP)
    except OSError:
        raise NarrateRefusal(400, (
            f"'{host}' could not be resolved from this deployment. {PASTE_INSTEAD}"))
    if not infos:
        raise NarrateRefusal(400, (
            f"'{host}' resolved to no addresses. {PASTE_INSTEAD}"))
    # EVERY address, not the first: a host that answers with one public and one
    # private A record must not be narratable on a coin flip.
    for info in infos:
        check_public_ip(info[4][0])
    return host, str(port)


class _GuardedRedirects(urllib.request.HTTPRedirectHandler):
    """Re-validate every hop.

    A 302 to http://169.254.169.254/ is the textbook SSRF bypass: the first URL
    passes every check and the request still ends up at the metadata service.
    So the same guard runs on the Location of each redirect, and the refusal
    names the hop that was rejected rather than reporting a generic failure on
    the URL the caller actually sent.
    """

    def __init__(self, allow: list[str]) -> None:
        self.allow = allow
        self.hops = 0

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001
        self.hops += 1
        if self.hops > MAX_REDIRECTS:
            raise NarrateRefusal(400, (
                f"that URL redirected more than {MAX_REDIRECTS} times. {PASTE_INSTEAD}"))
        guard_url(newurl, self.allow)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


_TEXTUAL = ("text/html", "text/plain", "text/markdown", "application/xhtml+xml")

#: Seam. Tests substitute an opener rather than a network; patching
#: `urllib.request.build_opener` itself would reach into every other module in
#: the process that happens to be opening a URL at the time.
_build_opener = urllib.request.build_opener


def fetch_url(url: str) -> tuple[str, str]:
    """Fetch an allowlisted, public, size- and time-capped page.

    Returns (kind, body) where kind is "html" or "markdown".

    Known and accepted limit: DNS is resolved twice (once by `guard_url`, once
    by the socket layer), so a rebinding attacker with control of a host that is
    ALREADY on the operator's allowlist could win the race. The allowlist is the
    primary control precisely because it is not subject to that race; the IP
    check is defence in depth against an allowlisted host that has been pointed
    somewhere it should not be.
    """
    allow = _allow_hosts()
    guard_url(url, allow)
    max_bytes, timeout = _fetch_limits()

    handler = _GuardedRedirects(allow)
    opener = _build_opener(handler)
    req = urllib.request.Request(url, headers={
        "User-Agent": "Gravitone-Narrate/1 (+/v1/narrate)",
        "Accept": "text/html, text/markdown, text/plain;q=0.9",
    })
    try:
        with opener.open(req, timeout=timeout) as resp:
            ctype = (resp.headers.get("Content-Type") or "").split(";")[0].strip().lower()
            if ctype and not any(ctype == t for t in _TEXTUAL):
                raise NarrateRefusal(415, (
                    f"that URL served '{ctype}', which is not a readable page. "
                    f"{PASTE_INSTEAD}"))
            declared = resp.headers.get("Content-Length")
            if declared and declared.isdigit() and int(declared) > max_bytes:
                raise NarrateRefusal(413, (
                    f"that page declares {int(declared)} bytes, over the "
                    f"{max_bytes}-byte narration cap. {PASTE_INSTEAD}"))
            # One byte past the cap so a LYING Content-Length is caught too.
            raw = resp.read(max_bytes + 1)
            charset = resp.headers.get_content_charset() or "utf-8"
    except NarrateRefusal:
        raise
    except urllib.error.HTTPError as exc:
        raise NarrateRefusal(502, (
            f"that URL answered {exc.code}. {PASTE_INSTEAD}"))
    except (urllib.error.URLError, TimeoutError, socket.timeout, OSError) as exc:
        reason = getattr(exc, "reason", exc)
        raise NarrateRefusal(504, (
            f"that URL could not be read within {timeout:g}s ({reason}). "
            f"{PASTE_INSTEAD}"))
    if len(raw) > max_bytes:
        raise NarrateRefusal(413, (
            f"that page is larger than the {max_bytes}-byte narration cap. "
            f"{PASTE_INSTEAD}"))
    try:
        body = raw.decode(charset, "replace")
    except LookupError:
        body = raw.decode("utf-8", "replace")
    return ("markdown" if ctype == "text/markdown" else "html"), body


# -- the bounded plan store ---------------------------------------------------

def _valid_id(narration_id: str) -> bool:
    return bool(narration_id) and narration_id.isalnum() and len(narration_id) <= 32


def _evict_oldest() -> None:
    """Oldest-first, no lineage to protect (a plan references nothing)."""
    try:
        metas = sorted(NARRATIONS_DIR.glob("*.json"), key=lambda p: p.stat().st_mtime)
    except OSError:
        return
    for old in metas[: max(0, len(metas) - MAX_NARRATIONS + 1)]:
        old.unlink(missing_ok=True)


def _store(record: dict) -> None:
    NARRATIONS_DIR.mkdir(parents=True, exist_ok=True)
    _evict_oldest()
    (NARRATIONS_DIR / f"{record['narration_id']}.json").write_text(
        json.dumps(record), "utf-8")


# -- the routes ---------------------------------------------------------------

class NarrateReq(BaseModel):
    """Exactly one source. Three fields rather than one polymorphic `content`
    because "this is markdown" is knowledge the caller has and a sniffer only
    guesses at."""

    url: str | None = Field(None, max_length=2000)
    markdown: str | None = Field(None, max_length=MAX_BODY_CHARS)
    html: str | None = Field(None, max_length=MAX_BODY_CHARS)
    title: str = Field("", max_length=MAX_LABEL)
    #: Optional. When present, every block's addressing is fully resolved and a
    #: client can synthesize without a roster lookup. When absent the plan still
    #: carries `character_hint` per block and the client picks -- which is what
    #: the shell's dock does, because the listener chooses their narrator there.
    character_id: str = Field("", max_length=100)


def _addressing(character_id: str, block: dict) -> dict:
    """How a client turns THIS block into audio -- through the ordinary route.

    Two shapes, both already shipped, neither invented here:
      * /v1/speak {character_id, text}  -- metatag-aware; the inline
        [emotion]...[/emotion] wrapper switches the Character's Voice, and the
        response reports what was actually used. This is what the studio and
        the narration dock already call.
      * /v1/text-to-speech/{character:emotion} -- the drop-in ElevenLabs route
        with emotion addressing in the voice_id, for clients that only speak
        ElevenLabs.
    """
    voice_id = f"{character_id}:{block['emotion']}" if character_id else None
    return {
        "voice_id": voice_id,
        "speak": {
            "route": "/v1/speak",
            "body": {"character_id": character_id or None, "text": block["tagged_text"]},
        },
        "drop_in": {
            "route": f"/v1/text-to-speech/{voice_id}" if voice_id else None,
            "body": {"text": block["text"]},
        },
    }


@router.post("", status_code=201)
def create_narration(req: NarrateReq) -> dict:
    """Turn a page into a narration plan. Synthesizes nothing."""
    sources = [name for name in ("url", "markdown", "html") if getattr(req, name)]
    if len(sources) != 1:
        raise HTTPException(400, (
            "send exactly one of `url`, `markdown` or `html` "
            f"(got {len(sources)})"))
    source = sources[0]

    try:
        if source == "url":
            kind, body = fetch_url(req.url or "")
        else:
            kind, body = source, (getattr(req, source) or "")
        title, pieces = (extract_markdown(body) if kind == "markdown"
                         else extract_html(body))
    except NarrateRefusal as refusal:
        raise HTTPException(refusal.status, refusal.message)

    blocks = build_blocks(pieces)
    if not blocks:
        raise HTTPException(422, (
            "no readable text could be extracted from that content - "
            f"{PASTE_INSTEAD}"))

    for block in blocks:
        emotion = block["emotion"]
        block["tagged_text"] = f"[{emotion}]{block['text']}[/{emotion}]"
        # Character-independent on purpose: a plan's hash identifies WHAT is
        # said, so two deployments narrating the same page agree on it. The
        # per-clip cache key adds the narrator on top (see clipKey in
        # web/lib/narratable.ts) because that IS audio-affecting.
        block["hash"] = hash_parts(emotion, block["text"])
        block["addressing"] = _addressing(req.character_id.strip(), block)

    narration_id = uuid.uuid4().hex[:10]
    record = {
        "narration_id": narration_id,
        "title": (req.title.strip() or title or "This page, read aloud")[:MAX_LABEL],
        "source": source,
        # The URL is echoed, the BODY never is: a plan is a reading order, not a
        # copy of the caller's document sitting in a shared store.
        "url": req.url if source == "url" else None,
        "character_id": req.character_id.strip() or None,
        "created": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "blocks": blocks,
        "seconds_estimate": round(
            sum(len(b["text"]) for b in blocks) / 15.0, 1),  # ~15 chars/second
        "synthesis": (
            "Blocks render lazily through the existing TTS routes - see each "
            "block's `addressing`. Nothing has been synthesized yet."),
    }
    _store(record)
    return record


@router.get("/{narration_id}")
def get_narration(narration_id: str) -> dict:
    path = NARRATIONS_DIR / f"{narration_id}.json"
    if not _valid_id(narration_id) or not path.is_file():
        raise HTTPException(404, (
            "narration not found - plans are evicted oldest-first; POST the "
            "content again to get a fresh one"))
    try:
        return json.loads(path.read_text("utf-8"))
    except (OSError, json.JSONDecodeError):
        raise HTTPException(404, "that narration plan could not be read back")
