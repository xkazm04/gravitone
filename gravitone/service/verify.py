"""Did the audio say the words? — the pure half of verified speech.

Synthesis is CPU-local and unmetered here, so this service can afford what a
per-character cloud vendor structurally cannot: a SECOND inference pass that
grades the first one. ``service/stt.py`` already gives the conversation layer
word-level timestamps; this module is everything that has to happen around
those word spans, and it deliberately contains no model, no I/O and no clock:

  * a **text normalizer** shared by BOTH sides of the comparison (the request
    text and the transcript), so "42" vs "forty two", "Dr." vs "doctor" and
    "don't" vs "dont" are the same words rather than three false failures;
  * a **homophone carve-out** applied to what is left over after all of that
    (``_split_homophones``): "their" for "there" is one sound, so it is not a
    synthesis defect and must not be charged as one;
  * a **word-level alignment mapper** that carries ASR ``Word`` spans back onto
    the ORIGINAL request text (character offsets included — the caller asked
    for a timeline over the words it sent, not over what the ear heard);
  * a **fidelity scorer** with a confidence floor: an ASR stumble must never be
    reported as a TTS defect, so words the transcriber is unsure of are
    UNRATED — excluded from numerator and denominator alike — never counted as
    errors.

Absent is not zero (the batch-1 vocabulary): a clip with nothing rateable
scores ``None``/"unrated", never 0.0. A zero would read as "the voice said
nothing right", which is a claim this module cannot make.

Everything here is deterministic and unit-testable without weights
(``service/tests/test_verify.py``); the model-shaped half lives in
``service/app.py``.
"""
from __future__ import annotations

import base64
import json
import re
import unicodedata
from dataclasses import dataclass, field
from difflib import SequenceMatcher

# Words the transcriber is less sure of than this are UNRATED: not counted as
# matches, not counted as errors, and never allowed to produce a delta. Whisper
# word probabilities on clean synthetic speech sit far above this; the floor is
# there to stop a proper noun the ear fumbled from indicting the mouth.
MIN_WORD_CONFIDENCE = 0.55

# How many deltas travel in a response header. The score is the verdict; the
# deltas are evidence, and an unbounded evidence list is a header a proxy drops.
MAX_HEADER_DELTAS = 12

# ---------------------------------------------------------------------------
# Normalization
# ---------------------------------------------------------------------------
# A "word" for comparison purposes: a run of letters (with internal
# apostrophes), a number (with thousands separators / a decimal point), or one
# of the two symbols that are pronounced as words.
_WORD_RE = re.compile(
    r"\d+(?:[.,]\d+)*|[^\W\d_]+(?:['’][^\W\d_]+)*|[&%]",
    re.UNICODE,
)

_ONES = ("zero", "one", "two", "three", "four", "five", "six", "seven",
         "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen",
         "fifteen", "sixteen", "seventeen", "eighteen", "nineteen")
_TENS = ("", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy",
         "eighty", "ninety")
_SCALES = ((10 ** 9, "billion"), (10 ** 6, "million"), (1000, "thousand"),
           (100, "hundred"))

# Written forms whose spoken form is a different word (or words). Only entries
# whose expansion is unambiguous in ordinary narration are here: "St." is
# deliberately absent (Street? Saint?), because a wrong expansion manufactures
# a delta, which is worse than no tolerance at all.
ABBREVIATIONS: dict[str, tuple[str, ...]] = {
    "dr": ("doctor",),
    "mr": ("mister",),
    "mrs": ("missus",),
    "prof": ("professor",),
    "jr": ("junior",),
    "sr": ("senior",),
    "vs": ("versus",),
    "etc": ("et", "cetera"),
    "approx": ("approximately",),
    "dept": ("department",),
    "ave": ("avenue",),
    "blvd": ("boulevard",),
    "ok": ("okay",),
    "&": ("and",),
    "%": ("percent",),
}


# Words that are the SAME SOUND and a different spelling. Consulted only for
# residual mismatches (see ``_split_homophones``), never during normalization.
#
# Why a curated table and not Soundex/Metaphone: a phonetic hash does not encode
# "identical pronunciation", it encodes "similar consonant skeleton", and it is
# far too coarse for a claim-checker. Soundex maps both "react" and "rust" to
# R230 — this suite's own canonical example of a real synthesis defect
# (test_verify: "Deploy the react app" heard as "rust") would become a PASS.
# The table below cannot do that: every entry is a pair a listener could not
# tell apart either, so forgiving it forgives nothing audible.
#
# Admission rules for an entry, and they are what keep the false-PASS class
# small: (1) identical pronunciation in general American, not merely similar —
# "marry"/"merry" and "caught"/"court" are accent-dependent and are OUT;
# (2) no heteronyms — "read"/"reed" and "lead"/"led" are excluded because a
# synthesizer really can read the wrong one of those aloud, and that IS a defect
# an ear can hear. Groups are matched pairwise and NOT transitively, so a word
# may sit in two groups without merging them.
_HOMOPHONE_GROUPS: tuple[tuple[str, ...], ...] = (
    ("their", "there", "theyre"), ("to", "too", "two"), ("your", "youre"),
    ("whose", "whos"), ("hear", "here"), ("for", "four", "fore"),
    ("by", "buy", "bye"), ("no", "know"), ("one", "won"),
    ("right", "write", "rite", "wright"), ("new", "knew"), ("see", "sea"),
    ("son", "sun"), ("weather", "whether"), ("wear", "where", "ware"),
    ("knight", "night"), ("flour", "flower"), ("piece", "peace"),
    ("ate", "eight"), ("mail", "male"), ("meat", "meet"),
    ("pair", "pear", "pare"), ("plain", "plane"), ("rain", "reign", "rein"),
    ("road", "rode"), ("sight", "site", "cite"), ("steal", "steel"),
    ("tail", "tale"), ("threw", "through"), ("waist", "waste"),
    ("wait", "weight"), ("way", "weigh"), ("week", "weak"), ("wood", "would"),
    ("hour", "our"), ("allowed", "aloud"), ("bare", "bear"),
    ("brake", "break"), ("cell", "sell"), ("cent", "scent", "sent"),
    ("dear", "deer"), ("die", "dye"), ("fair", "fare"), ("flee", "flea"),
    ("heal", "heel"), ("hi", "high"), ("hole", "whole"), ("made", "maid"),
    ("main", "mane"), ("passed", "past"), ("peak", "peek"), ("sale", "sail"),
    ("stair", "stare"), ("throne", "thrown"), ("toe", "tow"),
    ("vain", "vein", "vane"), ("board", "bored"), ("cheap", "cheep"),
    ("coarse", "course"), ("great", "grate"), ("groan", "grown"),
    ("guessed", "guest"), ("him", "hymn"), ("in", "inn"), ("knot", "not"),
    ("lessen", "lesson"), ("loan", "lone"), ("mind", "mined"),
    ("morning", "mourning"), ("none", "nun"), ("or", "oar", "ore"),
    ("pale", "pail"), ("pause", "paws"), ("poll", "pole"),
    ("praise", "prays", "preys"), ("rap", "wrap"), ("ring", "wring"),
    ("role", "roll"), ("scene", "seen"), ("sew", "so"), ("some", "sum"),
    ("stake", "steak"), ("stationary", "stationery"), ("tide", "tied"),
    ("toad", "towed"), ("which", "witch"), ("whine", "wine"),
    ("berry", "bury"), ("blew", "blue"), ("ceiling", "sealing"),
    ("chord", "cord"), ("complement", "compliment"), ("council", "counsel"),
    ("creak", "creek"), ("crews", "cruise"), ("currant", "current"),
    ("dew", "due", "do"),
)

HOMOPHONES: dict[str, frozenset[str]] = {}
for _group in _HOMOPHONE_GROUPS:
    for _word in _group:
        HOMOPHONES[_word] = HOMOPHONES.get(_word, frozenset()) | (
            frozenset(_group) - {_word})
del _group, _word


def homophones(word: str) -> frozenset[str]:
    """Every word that is pronounced exactly like ``word`` (folded form)."""
    return HOMOPHONES.get(word, frozenset())


def fold(raw: str) -> str:
    """Case/punctuation folding: the smallest transformation that makes two
    spellings of the SAME spoken word compare equal.

    NFKC first (so a full-width or ligature form does not read as a different
    word), then lowercase, then drop apostrophes — "don't" and "dont" are one
    word said one way, and the transcriber picks whichever it likes.
    """
    folded = unicodedata.normalize("NFKC", raw).lower()
    return folded.replace("'", "").replace("’", "")


def number_words(n: int) -> list[str]:
    """English words for an integer ("forty two"), no "and", no hyphens.

    Above a trillion this gives up and the caller falls back to digit-by-digit:
    nobody narrates a 15-digit number as a quantity.
    """
    if n < 0:
        return ["minus"] + number_words(-n)
    if n < 20:
        return [_ONES[n]]
    if n < 100:
        tens, rest = divmod(n, 10)
        return [_TENS[tens]] + ([_ONES[rest]] if rest else [])
    for value, name in _SCALES:
        if n >= value:
            head, rest = divmod(n, value)
            out = number_words(head) + [name]
            if rest:
                out += number_words(rest)
            return out
    return [_ONES[0]]  # pragma: no cover - unreachable (n >= 0 and n < 100 above)


def _digits_words(digits: str) -> list[str]:
    return [_ONES[int(d)] for d in digits]


def numeral_variants(raw: str) -> list[list[str]]:
    """Every way a written numeral is plausibly SPOKEN, best guess first.

    "1990" is "one thousand nine hundred ninety" to an accountant and
    "nineteen ninety" to everyone else; "1905" is "nineteen oh five"; a leading
    zero ("007") is always read digit by digit. The comparison uses the first
    variant as the canonical form and accepts any of the others rather than
    reporting a delta — this is the "numerals and abbreviations diverge between
    written and spoken form" risk, handled instead of documented.
    """
    cleaned = raw.replace(",", "").replace(" ", "")
    if "." in cleaned:
        whole, _, frac = cleaned.partition(".")
        head = numeral_variants(whole)[0] if whole else ["zero"]
        tail = _digits_words(frac) if frac.isdigit() else []
        return [head + ["point"] + tail]
    if not cleaned.isdigit():
        return [[fold(cleaned)]]
    per_digit = _digits_words(cleaned)
    if cleaned.startswith("0") or len(cleaned) > 12:
        return [per_digit]

    n = int(cleaned)
    variants: list[list[str]] = [number_words(n)]
    if len(cleaned) == 4 and n >= 1000:
        century, rest = divmod(n, 100)
        if rest == 0:
            variants.append(number_words(century) + ["hundred"])
        elif rest < 10:
            variants.append(number_words(century) + ["oh"] + number_words(rest))
        else:
            variants.append(number_words(century) + number_words(rest))
    if per_digit not in variants:
        variants.append(per_digit)
    return variants


@dataclass(frozen=True)
class Token:
    """One canonical spoken word, and where it came from in the source text.

    ``group`` is the index of the SOURCE word that produced it: "42" is one
    source word and two tokens, and the alignment mapper needs to hand the
    caller back a span over the text it sent, not over the expansion.
    """
    text: str
    start: int          # character offset of the source word, inclusive
    end: int            # character offset of the source word, exclusive
    group: int
    numeric: bool = False


def normalize(text: str) -> list[Token]:
    """The one normalizer BOTH sides of every comparison go through.

    Two normalizers would be two definitions of "the same words", which is how
    a verifier ends up reporting differences that only exist in its own
    plumbing. Punctuation and whitespace vanish, case folds, numerals expand to
    their canonical spoken form, and known abbreviations expand to what they
    are read as.
    """
    tokens: list[Token] = []
    for group, m in enumerate(_WORD_RE.finditer(text or "")):
        raw = m.group(0)
        start, end = m.start(), m.end()
        folded = fold(raw)
        if folded[:1].isdigit():
            words = numeral_variants(raw)[0]
            numeric = True
        else:
            words = list(ABBREVIATIONS.get(folded, (folded,)))
            numeric = False
        for word in words:
            if word:
                tokens.append(Token(word, start, end, group, numeric))
    return tokens


def canonical_words(text: str) -> list[str]:
    """``normalize`` reduced to the bare word list (the comparison alphabet)."""
    return [t.text for t in normalize(text)]


def source_words(text: str) -> list[tuple[int, int, int]]:
    """``(group, start, end)`` for each SOURCE word of ``text``, in order."""
    return [(i, m.start(), m.end())
            for i, m in enumerate(_WORD_RE.finditer(text or ""))]


# ---------------------------------------------------------------------------
# The heard side
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class Heard:
    """One normalized token of the TRANSCRIPT, with its time and confidence."""
    text: str
    start_s: float | None = None
    end_s: float | None = None
    confidence: float | None = None

    @property
    def rated(self) -> bool:
        """Whether this word may be used to judge the SYNTHESIS.

        ``None`` (the transcriber reported no probability) is rated: refusing
        to score anything at all would be a quieter lie than scoring on words
        whose confidence is merely unknown. ``FidelityReport.confidence_source``
        says which of the two happened, so nothing is hidden.
        """
        return self.confidence is None or self.confidence >= MIN_WORD_CONFIDENCE


def word_confidence(word) -> float | None:
    """The transcriber's confidence for one word, whatever it calls it.

    ``service.stt.Word`` carries faster-whisper's per-word probability, but only
    on a decode that asked for word timestamps — without them the model emits no
    words at all. When there is no number this returns None and the report says
    ``confidence_source`` rather than pretending to a floor it never applied.
    """
    for attr in ("confidence", "probability", "prob"):
        value = getattr(word, attr, None)
        if value is None and isinstance(word, dict):
            value = word.get(attr)
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            return float(value)
    return None


def _word_text(word) -> str:
    if isinstance(word, dict):
        return str(word.get("text", ""))
    return str(getattr(word, "text", "") or "")


def _word_span(word) -> tuple[float | None, float | None]:
    if isinstance(word, dict):
        return word.get("start"), word.get("end")
    return getattr(word, "start", None), getattr(word, "end", None)


def heard_tokens(heard) -> list[Heard]:
    """Normalize a transcript into comparable, timed, confidence-carrying tokens.

    ``heard`` is either a plain string (no timing, no confidence — the degraded
    shape) or a sequence of ASR word objects/dicts (``service.stt.Word`` and
    anything duck-shaped like it). A word that expands to several tokens
    ("42" -> "forty two") splits its span evenly across them, so the timeline
    stays monotonic.
    """
    if isinstance(heard, str):
        return [Heard(t.text) for t in normalize(heard)]
    out: list[Heard] = []
    for word in heard or []:
        conf = word_confidence(word)
        start, end = _word_span(word)
        parts = [t.text for t in normalize(_word_text(word))]
        if not parts:
            continue
        for i, text in enumerate(parts):
            if start is None or end is None or len(parts) == 1:
                out.append(Heard(text, start, end, conf))
                continue
            step = (float(end) - float(start)) / len(parts)
            out.append(Heard(text, round(float(start) + i * step, 3),
                             round(float(start) + (i + 1) * step, 3), conf))
    return out


# ---------------------------------------------------------------------------
# Fidelity
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class Delta:
    """One difference between what was asked for and what was heard."""
    kind: str            # missing | extra | wrong
    expected: str        # canonical reference words ("" for `extra`)
    heard: str           # canonical transcript words ("" for `missing`)
    at: int              # character offset in the request text
    rated: bool = True   # False => the ear was unsure; not counted against TTS

    def to_dict(self) -> dict:
        return {"kind": self.kind, "expected": self.expected,
                "heard": self.heard, "at": self.at, "rated": self.rated}


@dataclass
class FidelityReport:
    """What the second pass measured, and what it refuses to claim.

    ``score`` is ``matched / (matched + errors)`` over RATED words only, or
    None when nothing was rateable (silence, an empty transcript, or a clip the
    ear was unsure of end to end). None is not zero.
    """
    score: float | None
    matched: int = 0
    errors: int = 0
    unrated: int = 0
    reference_words: int = 0
    heard_words: int = 0
    # Which of three different things happened to the confidence floor, because
    # only one of them is a fact about the audio:
    #   "asr"      — the transcriber rated words and the floor was applied;
    #   "unrated"  — words came back carrying no probability. The ear could not
    #                rate them; that IS about this clip;
    #   "no-words" — the comparison was handed flat text, so there was nothing
    #                to rate. Nobody asked the model for word-level output. That
    #                is about the REQUEST, not about the audio, and conflating
    #                the two makes a weak claim look like a measured one.
    confidence_source: str = "no-words"
    deltas: list[Delta] = field(default_factory=list)

    @property
    def rated_deltas(self) -> list[Delta]:
        return [d for d in self.deltas if d.rated]

    def to_dict(self, limit: int | None = None) -> dict:
        deltas = self.rated_deltas
        if limit is not None:
            deltas = deltas[:limit]
        return {
            "score": self.score,
            "matched": self.matched,
            "errors": self.errors,
            "unrated": self.unrated,
            "reference_words": self.reference_words,
            "heard_words": self.heard_words,
            "confidence_source": self.confidence_source,
            "deltas": [d.to_dict() for d in deltas],
            "truncated": limit is not None and len(self.rated_deltas) > limit,
        }


def _variant_matches(ref: list[Token], hyp: list[Heard], text: str) -> bool:
    """Whether a differing block is just a numeral read a different way."""
    groups = {t.group for t in ref}
    if len(groups) != 1 or not ref or not all(t.numeric for t in ref):
        return False
    token = ref[0]
    raw = text[token.start:token.end]
    spoken = [h.text for h in hyp]
    return any(variant == spoken for variant in numeral_variants(raw))


def _blocks(ref: list[Token], hyp: list[Heard], text: str) -> list[tuple]:
    """Diff the two canonical word streams, keeping numerals whole.

    A plain LCS diff happily splits a numeral down the middle: "1990" expands to
    five canonical words, "nineteen ninety" is two, and the shared trailing
    "ninety" makes the differing part look like four words replaced by one. The
    written form is then unrecognisable as a number and the request is reported
    as 71% correct when it was read perfectly.

    So any non-equal block that touches a numeral is first GROWN to whole
    numeral boundaries (stealing from the neighbouring equal runs, which stay
    1:1 paired because only their edges move), and a block that then equals one
    of the numeral's spoken variants becomes its own opcode, ``numeral`` — a
    match for scoring, and a single timed span for alignment.
    """
    matcher = SequenceMatcher(None, [t.text for t in ref], [h.text for h in hyp],
                              autojunk=False)
    blocks = [list(op) for op in matcher.get_opcodes()]
    first: dict[int, int] = {}
    last: dict[int, int] = {}
    for idx, token in enumerate(ref):
        if token.numeric:
            first.setdefault(token.group, idx)
            last[token.group] = idx

    i = 0
    while i < len(blocks):
        op = blocks[i][0]
        if op == "equal":
            i += 1
            continue
        groups = {ref[k].group for k in range(blocks[i][1], blocks[i][2])
                  if ref[k].numeric}
        if not groups:
            i += 1
            continue
        lo = min(first[g] for g in groups)
        hi = max(last[g] for g in groups) + 1
        while lo < blocks[i][1] and i > 0:
            prev = blocks[i - 1]
            if prev[0] == "equal":
                take = min(blocks[i][1] - lo, prev[2] - prev[1])
                prev[2] -= take
                prev[4] -= take
                blocks[i][1] -= take
                blocks[i][3] -= take
                if prev[1] >= prev[2]:
                    blocks.pop(i - 1)
                    i -= 1
            else:
                blocks[i][1], blocks[i][3] = prev[1], prev[3]
                blocks.pop(i - 1)
                i -= 1
        while hi > blocks[i][2] and i + 1 < len(blocks):
            nxt = blocks[i + 1]
            if nxt[0] == "equal":
                take = min(hi - blocks[i][2], nxt[2] - nxt[1])
                nxt[1] += take
                nxt[3] += take
                blocks[i][2] += take
                blocks[i][4] += take
                if nxt[1] >= nxt[2]:
                    blocks.pop(i + 1)
            else:
                blocks[i][2], blocks[i][4] = nxt[2], nxt[4]
                blocks.pop(i + 1)
        _, i1, i2, j1, j2 = blocks[i]
        if _variant_matches(ref[i1:i2], hyp[j1:j2], text):
            blocks[i][0] = "numeral"
        elif i1 == i2:
            blocks[i][0] = "insert"
        elif j1 == j2:
            blocks[i][0] = "delete"
        else:
            blocks[i][0] = "replace"
        i += 1
    return [tuple(b) for b in _split_homophones(blocks, ref, hyp)]


def _split_homophones(blocks: list[list], ref: list[Token],
                      hyp: list[Heard]) -> list[list]:
    """Carve the same-sounding pairs out of the mismatches that are left.

    A homophone slip is not a synthesis defect: "their" and "there" are one
    sound, so an ASR cannot tell which one the mouth produced and neither could
    a listener. Charging it to the synthesizer is a false FAIL — and ``verify``
    can REFUSE a render (``?verify=strict``), which makes that the expensive
    direction of wrong.

    Deliberately narrow, because loosening a checker makes false PASSES cheaper:

      * it runs LAST, over residual ``replace`` blocks only — words the diff has
        already paired 1:1 and everything else has already failed to explain. A
        phonetic pass over the whole transcript would be a different, much
        broader tool;
      * only equal-length blocks qualify (a substitution that changed the word
        count is not a homophone slip);
      * pairs are forgiven INDIVIDUALLY. "their house" heard as "there hose"
        still reports one ``wrong`` — the homophone is carved out, the real
        error is charged.

    What this can now let through, stated plainly: a synthesizer that renders a
    word as a different, identically-pronounced word. That failure is inaudible
    by construction (that is what "identical pronunciation" means), so the class
    of real defect being lost is the one nobody could hear — with one honest
    exception, "2" read as "to", where the writing carried a distinction the
    speech never could.
    """
    out: list[list] = []
    for block in blocks:
        op, i1, i2, j1, j2 = block
        if op != "replace" or (i2 - i1) != (j2 - j1) or i2 == i1:
            out.append(block)
            continue
        run_op: str | None = None
        run_start = 0
        span = i2 - i1
        for k in range(span + 1):
            kind = None if k == span else (
                "homophone" if hyp[j1 + k].text in homophones(ref[i1 + k].text)
                else "replace")
            if kind != run_op:
                if run_op is not None:
                    out.append([run_op, i1 + run_start, i1 + k,
                                j1 + run_start, j1 + k])
                run_op, run_start = kind, k
    return out


def compare(reference_text: str, heard, *,
            min_confidence: float = MIN_WORD_CONFIDENCE) -> FidelityReport:
    """Score what was heard against what was asked for.

    The alignment is a longest-common-subsequence diff over the CANONICAL word
    streams (both sides through ``normalize``), so a dropped word, a mangled
    word and an invented word are three distinguishable outcomes rather than
    one "they differ".

    The confidence floor is applied at BLOCK level, which is the only place it
    means anything: a difference whose heard side is entirely low-confidence is
    an ASR stumble, so its reference words become UNRATED — removed from the
    denominator — instead of errors charged to the synthesizer.
    """
    ref = normalize(reference_text)
    hyp = heard_tokens(heard)
    confidences = [h.confidence for h in hyp if h.confidence is not None]
    if confidences:
        source = "asr"
    elif isinstance(heard, str):
        # Flat text: the decode was run without word timestamps, which is the
        # only way faster-whisper emits per-word probabilities. Nobody asked.
        source = "no-words"
    else:
        source = "unrated"
    report = FidelityReport(
        score=None, reference_words=len(ref), heard_words=len(hyp),
        confidence_source=source)

    def rated(h: Heard) -> bool:
        return h.confidence is None or h.confidence >= min_confidence

    for op, i1, i2, j1, j2 in _blocks(ref, hyp, reference_text):
        ref_block, hyp_block = ref[i1:i2], hyp[j1:j2]
        if op in ("equal", "homophone"):
            # A homophone pair is one sound: the ear cannot have distinguished
            # it and neither could a listener, so it is a match — but still
            # subject to the confidence floor, exactly like an equal pair.
            for token, word in zip(ref_block, hyp_block):
                if rated(word):
                    report.matched += 1
                else:
                    report.unrated += 1
            continue

        if op == "numeral":
            # Same number, different reading ("nineteen ninety" for 1990).
            report.matched += len(ref_block)
            continue

        block_rated = any(rated(h) for h in hyp_block) if hyp_block else True
        at = ref_block[0].start if ref_block else (
            ref[i1 - 1].end if i1 else 0)
        kind = {"delete": "missing", "insert": "extra"}.get(op, "wrong")
        report.deltas.append(Delta(
            kind=kind,
            expected=" ".join(t.text for t in ref_block),
            heard=" ".join(h.text for h in hyp_block),
            at=at, rated=block_rated))
        if block_rated:
            report.errors += max(len(ref_block), len(hyp_block))
        else:
            report.unrated += len(ref_block)

    denominator = report.matched + report.errors
    report.score = round(report.matched / denominator, 3) if denominator else None
    return report


def deltas_header(report: FidelityReport,
                  limit: int = MAX_HEADER_DELTAS) -> str:
    """The evidence, base64-JSON — the shape ``X-Segments`` already uses.

    Base64 and not plain text on purpose: a delta quotes the words themselves,
    and HTTP headers are latin-1. A Czech proper noun in a header value is a
    500 waiting to happen.
    """
    payload = json.dumps(report.to_dict(limit=limit), ensure_ascii=False)
    return base64.b64encode(payload.encode("utf-8")).decode("ascii")


def format_score(score: float | None) -> str:
    """``"0.938"`` — or ``"unrated"`` when nothing could honestly be scored.

    "unrated" and not "0.000": absent is not zero, and a header a client parses
    with ``float()`` must fail loudly rather than read as a total failure.
    """
    return "unrated" if score is None else f"{float(score):.3f}"


def score_header(report: FidelityReport) -> str:
    """``format_score`` for a whole report."""
    return format_score(report.score)


# ---------------------------------------------------------------------------
# Alignment
# ---------------------------------------------------------------------------
@dataclass
class WordSpan:
    """One word of the REQUEST TEXT, placed on the audio timeline."""
    text: str            # the source substring, verbatim (not normalized)
    start: int           # character offset in the request text, inclusive
    end: int             # character offset, exclusive
    start_s: float
    end_s: float
    matched: bool        # True: anchored on a heard word; False: interpolated
    # The transcriber's confidence in the heard word(s) this span was anchored
    # on — the weakest RATED one, because a word is only as certain as its
    # least certain piece. None means nothing rated it: the ear reported no
    # probability, or the word was never heard at all (``matched: false``).
    # Absent is not zero; a caller dimming uncertain words must not dim a word
    # merely because nobody graded it.
    confidence: float | None = None

    def to_dict(self) -> dict:
        return {"text": self.text, "start": self.start, "end": self.end,
                "start_time_seconds": self.start_s,
                "end_time_seconds": self.end_s, "matched": self.matched,
                "confidence": self.confidence}


@dataclass
class Alignment:
    """Word + character timelines over the request text."""
    words: list[WordSpan]
    duration_s: float
    anchored: int = 0     # words whose time came from a heard word
    interpolated: int = 0  # words whose time was inferred from its neighbours

    def characters(self, text: str) -> dict:
        """The ElevenLabs `alignment` block: one time per CHARACTER.

        Characters inside a word split its span evenly; the characters BETWEEN
        two words (spaces, punctuation) fill the gap between them, so the
        timeline is continuous and monotonic — a caption renderer can index it
        directly.
        """
        chars = list(text or "")
        starts = [0.0] * len(chars)
        ends = [0.0] * len(chars)
        if not chars:
            return {"characters": [], "character_start_times_seconds": [],
                    "character_end_times_seconds": []}
        cursor = 0.0
        idx = 0
        for span in self.words:
            if span.start > idx:  # the gap before this word
                gap = max(1, span.start - idx)
                step = (span.start_s - cursor) / gap
                for k in range(idx, span.start):
                    starts[k] = round(cursor + (k - idx) * step, 3)
                    ends[k] = round(cursor + (k - idx + 1) * step, 3)
            width = max(1, span.end - span.start)
            step = (span.end_s - span.start_s) / width
            for k in range(span.start, span.end):
                starts[k] = round(span.start_s + (k - span.start) * step, 3)
                ends[k] = round(span.start_s + (k - span.start + 1) * step, 3)
            cursor = span.end_s
            idx = span.end
        for k in range(idx, len(chars)):  # trailing punctuation / whitespace
            starts[k] = round(cursor, 3)
            ends[k] = round(self.duration_s, 3)
        return {"characters": chars,
                "character_start_times_seconds": starts,
                "character_end_times_seconds": ends}

    def normalized(self) -> dict:
        """The same timeline over the CANONICAL words, space-joined.

        ElevenLabs returns both; the normalized one is what a lip-sync or
        karaoke consumer wants, because it carries no punctuation to skip.
        """
        text = " ".join(w.text for w in self.words)
        spans: list[WordSpan] = []
        cursor = 0
        for span in self.words:
            spans.append(WordSpan(span.text, cursor, cursor + len(span.text),
                                  span.start_s, span.end_s, span.matched,
                                  span.confidence))
            cursor += len(span.text) + 1
        return Alignment(spans, self.duration_s).characters(text)


def align(reference_text: str, heard, *, duration_s: float,
          min_confidence: float = MIN_WORD_CONFIDENCE) -> Alignment:
    """Carry heard word spans back onto the words of the REQUEST text.

    The caller asked for a timeline over the text it sent. Reporting the ASR's
    own words instead would hand back a timeline for a slightly different
    sentence — which is exactly the failure mode that makes third-party
    alignment vendors unusable for dubbing.

    Anchoring: words the diff matched take the heard word's span; a word the
    diff REPLACED still takes its positional counterpart's span (it landed
    somewhere, even if it came out wrong) but is reported ``matched: false``;
    a word with no counterpart at all is interpolated between its neighbours.
    Low-confidence heard words are usable as timing anchors even though they
    are not usable as evidence — where a word lands and whether it was right
    are two different questions. Each span reports that confidence
    (``WordSpan.confidence``) so a punch-in editor can draw the difference
    between a word the ear was sure of and one it guessed at, instead of
    rendering every word with the same unstated certainty.
    """
    ref = normalize(reference_text)
    hyp = heard_tokens(heard)
    groups = source_words(reference_text)
    timings: dict[int, tuple[float, float, bool]] = {}
    # group -> the RATED confidences of every heard word that fed this source
    # word. Unrated heard words contribute nothing rather than a zero, exactly
    # as they contribute nothing to `compare`'s numerator or denominator.
    confs: dict[int, list[float]] = {}

    def _rate(group: int, block: list[Heard]) -> None:
        for h in block:
            if h.confidence is not None:
                confs.setdefault(group, []).append(float(h.confidence))

    for op, i1, i2, j1, j2 in _blocks(ref, hyp, reference_text):
        if op in ("delete", "insert"):
            continue
        if op == "numeral":
            _rate(ref[i1].group, hyp[j1:j2])
            # The whole numeral is ONE source word: it spans every heard word
            # that read it, and it really was matched.
            spans = [(float(h.start_s), float(h.end_s)) for h in hyp[j1:j2]
                     if h.start_s is not None and h.end_s is not None]
            if spans:
                timings[ref[i1].group] = (min(s for s, _ in spans),
                                          max(e for _, e in spans), True)
            continue
        for token, word in zip(ref[i1:i2], hyp[j1:j2]):
            _rate(token.group, [word])
            if word.start_s is None or word.end_s is None:
                continue
            start, end, was = timings.get(
                token.group, (float(word.start_s), float(word.end_s), False))
            timings[token.group] = (
                min(start, float(word.start_s)), max(end, float(word.end_s)),
                was or op in ("equal", "homophone"))

    spans: list[WordSpan] = []
    for group, start, end in groups:
        timed = timings.get(group)
        text = reference_text[start:end]
        rated = confs.get(group)
        conf = round(min(rated), 3) if rated else None
        if timed is None:
            spans.append(WordSpan(text, start, end, -1.0, -1.0, False, conf))
        else:
            spans.append(WordSpan(text, start, end, round(timed[0], 3),
                                  round(timed[1], 3), timed[2], conf))

    _interpolate(spans, duration_s)
    anchored = sum(1 for s in spans if s.matched)
    return Alignment(spans, round(float(duration_s), 3), anchored,
                     len(spans) - anchored)


def _interpolate(spans: list[WordSpan], duration_s: float) -> None:
    """Give every untimed word a plausible, monotonic span, in place.

    A run of untimed words between two anchors is spread evenly across the gap;
    a run at either end takes the clip's own edge. This is the honest kind of
    guess — ``matched: false`` says it was one.
    """
    total = round(float(duration_s), 3)
    n = len(spans)
    i = 0
    while i < n:
        if spans[i].start_s >= 0:
            i += 1
            continue
        j = i
        while j < n and spans[j].start_s < 0:
            j += 1
        left = spans[i - 1].end_s if i > 0 else 0.0
        right = spans[j].start_s if j < n else total
        if right < left:
            right = left
        step = (right - left) / (j - i)
        for k in range(i, j):
            spans[k].start_s = round(left + (k - i) * step, 3)
            spans[k].end_s = round(left + (k - i + 1) * step, 3)
        i = j
