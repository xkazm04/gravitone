"""Traffic shape for the load harness: WHEN requests arrive and WHAT they say.

``service/loadtest.py`` historically fired a fixed number of parallel requests
behind a semaphore, all carrying ONE constant sentence. That measures how many
simultaneous streams a box tolerates -- it cannot measure how many real users a
box serves, for two structural reasons this module removes:

1. **Arrival process.** Real callers arrive on their own schedule; they do not
   wait for the previous caller to finish. ``arrival_schedule`` produces the
   wall-clock offsets of a Poisson process (exponential inter-arrivals) so the
   driver can fire on time regardless of how many requests are still in flight.
2. **Corpus.** One constant text is the perfect cache key. ``corpus_sample`` /
   ``corpus_series`` draw varied scripts from in-repo snippets (no PII), so a
   run defeats the synthesis cache BY CONSTRUCTION -- a second honesty
   guarantee alongside ``--cache-mode bypass``, which only asks the server
   nicely.

Both functions are pure and deterministic per ``seed``: the same seed replays
the same run, which is what makes two capacity measurements comparable.
"""
from __future__ import annotations

import random

# Length buckets. A capacity number is only meaningful against a stated script
# mix, so the profile travels into the result JSON with the numbers.
PROFILES = ("short", "typical", "long", "mixed")
DEFAULT_PROFILE = "typical"

# How many snippets each bucket concatenates into one request body.
PROFILE_PARTS = {"short": 2, "typical": 4, "long": 9}

# Weights used by the "mixed" profile -- roughly what a voice product sees:
# mostly typical utterances, a tail of long-form narration.
MIXED_WEIGHTS = (("short", 0.35), ("typical", 0.5), ("long", 0.15))

# In-repo corpus. Generic product/narration lines: no PII, no customer data,
# no personal names, nothing that could not ship in a public repo.
SNIPPETS = {
    "short": [
        "Your order is ready.",
        "Thanks for waiting.",
        "The line is now open.",
        "Please hold for one moment.",
        "That is all set.",
        "Call ended.",
        "Recording has started.",
        "Try again in a minute.",
        "The download finished.",
        "Welcome back.",
        "One new message.",
        "Battery is low.",
        "Turn left ahead.",
        "The meeting starts soon.",
        "Saved to your library.",
        "Nothing else to report.",
    ],
    "typical": [
        "The service renders speech on the processor you already own, so no "
        "audio ever leaves the building.",
        "Every voice in the library is stored as a small set of weights that "
        "load in well under a second.",
        "If the queue is full the request is refused straight away rather than "
        "left waiting without an answer.",
        "A finished clip is written once and replayed from the cache until the "
        "text or the voice changes.",
        "The benchmark reports the highest arrival rate the box sustained "
        "inside the latency budget you declared.",
        "Streaming sends the first chunk as soon as the model has produced it, "
        "then the rest as it arrives.",
        "Consent is recorded next to the voice, and withdrawing it removes the "
        "voice from every future request.",
        "The certificate states which hardware produced the numbers and how "
        "the run was configured.",
        "Long scripts are split into sentences, rendered in order, and joined "
        "without an audible seam.",
        "A replica pool scales throughput by process, because the model itself "
        "holds the interpreter lock.",
        "Cold start loads the weights once; every request after that pays only "
        "for the audio it produces.",
        "Metrics count what was received, completed, refused and abandoned, so "
        "the totals always reconcile.",
        "The studio previews a voice before you commit it, and keeps the take "
        "you actually approved.",
        "An offline appliance carries its models with it and refuses to reach "
        "the network at all.",
    ],
    "long": [
        "Narration for a documentary segment begins with a wide description of "
        "the landscape, then narrows to the single detail the scene is about, "
        "holding the sentence long enough for the picture to settle.",
        "In a support call the assistant repeats the account detail back to the "
        "caller, explains what will happen next, and gives a plain timeframe "
        "rather than a vague promise about the coming days.",
        "The chapter opens quietly, with the sort of ordinary morning that a "
        "reader recognises immediately, and only much later does it become "
        "clear which small decision in it mattered.",
        "A training module walks through the procedure step by step, pausing "
        "between each instruction so a listener can follow along with their "
        "hands busy and their eyes somewhere else entirely.",
        "The announcement covers the change, the reason behind it, the people "
        "affected, and the single action each of them needs to take before the "
        "end of the working week.",
        "An audio guide describes the room from the doorway inward, naming what "
        "is on each wall in turn, so a visitor who cannot see it still knows "
        "where they are standing.",
        "The interview answer starts with a concession, moves through the two "
        "objections that usually follow, and closes on the point the speaker "
        "actually came to make.",
        "A weather bulletin gives the outlook for the coast first, then the "
        "inland valleys, then the high ground, with the warning repeated in "
        "full at the end for anyone joining late.",
        "The recipe explains why the pan must be hot before anything touches "
        "it, what the sound should be when it is, and how long to leave it "
        "alone once the first side has taken colour.",
        "A product tour introduces the workspace, the library and the console "
        "in that order, because each one is easier to understand once the one "
        "before it has been seen working.",
        "The historical note sets the date, the place and the two parties, then "
        "follows the single road that connected them across a season of very "
        "bad weather and worse roads.",
        "An accessibility statement lists what has been tested, what is known "
        "to fail, who to contact about it, and how long a reply normally "
        "takes, without hiding behind a standard number.",
        "The postmortem describes the failure in the order it was discovered "
        "rather than the order it happened, which is how the people on the "
        "call actually experienced the incident.",
        "A meditation track counts the breath slowly, leaves a long gap, and "
        "returns with the same phrasing each time so the listener stops "
        "needing to pay attention to the words at all.",
        "The field recording notes describe the equipment, the distance, the "
        "wind, and the two passing vehicles that ended up in the take, so "
        "another engineer could reproduce the session.",
        "An onboarding email read aloud covers the account, the first task, the "
        "place to ask questions, and the one setting that people most often "
        "wish they had changed on the first day.",
        "The safety briefing repeats the exits, the assembly point and the "
        "signal, in that order, twice, because the only version anyone "
        "remembers is the one they heard when they were not listening.",
        "A retrospective on the quarter names what shipped, what slipped, and "
        "what was quietly abandoned, and gives the abandoned work the same "
        "amount of time as the rest of it.",
    ],
}


def _rng(*parts) -> random.Random:
    """Deterministic RNG keyed by the given parts.

    Seeding ``random.Random`` with a string is stable across processes and
    platforms (CPython hashes it with sha512), which is exactly what a
    reproducible benchmark needs -- unlike ``hash()``.
    """
    return random.Random("|".join(str(p) for p in parts))


# ---------------------------------------------------------------------------
# Arrival process
# ---------------------------------------------------------------------------
def arrival_schedule(rate_rps: float, duration_s: float, seed: int = 0) -> list:
    """Wall-clock offsets (seconds from start) of a Poisson arrival process.

    Inter-arrival times are exponential with mean ``1 / rate_rps``, which is
    what "R requests per second on average, arriving independently" means. The
    returned offsets are ascending and strictly inside ``duration_s``.

    Deterministic: the same ``(rate_rps, duration_s, seed)`` always returns the
    same list, so a capacity run can be replayed exactly.
    """
    if rate_rps <= 0:
        raise ValueError("rate_rps must be > 0")
    if duration_s <= 0:
        raise ValueError("duration_s must be > 0")
    rng = _rng("arrival", rate_rps, duration_s, seed)
    offsets = []
    t = 0.0
    while True:
        t += rng.expovariate(rate_rps)
        if t >= duration_s:
            return offsets
        offsets.append(round(t, 6))


def schedule_stats(offsets, duration_s: float) -> dict:
    """Mean realised rate + mean inter-arrival of a schedule (pure, for JSON)."""
    n = len(offsets)
    gaps = [b - a for a, b in zip(offsets, offsets[1:])]
    return {
        "arrivals": n,
        "duration_s": round(float(duration_s), 3),
        "mean_rate_rps": round(n / duration_s, 4) if duration_s else None,
        "mean_interarrival_s": (round(sum(gaps) / len(gaps), 6) if gaps else None),
    }


# ---------------------------------------------------------------------------
# Corpus
# ---------------------------------------------------------------------------
def _bucket(profile: str, seed: int) -> str:
    if profile != "mixed":
        return profile
    r = _rng("bucket", seed).random()
    acc = 0.0
    for name, w in MIXED_WEIGHTS:
        acc += w
        if r < acc:
            return name
    return MIXED_WEIGHTS[-1][0]


def corpus_sample(profile: str = DEFAULT_PROFILE, seed: int = 0) -> str:
    """One request body drawn from the ``profile`` length distribution.

    Deterministic per ``(profile, seed)``. Distinct seeds overwhelmingly yield
    distinct texts -- the combinatorial space of ordered snippet sequences is
    far larger than any realistic run -- which is what stops a ramp from
    measuring the synthesis cache. Use ``corpus_series`` when you need that as
    a guarantee rather than a probability.
    """
    if profile not in PROFILES:
        raise ValueError(f"unknown profile {profile!r}; choose from {PROFILES}")
    bucket = _bucket(profile, seed)
    pool = SNIPPETS[bucket]
    parts = min(PROFILE_PARTS[bucket], len(pool))
    return " ".join(_rng("corpus", bucket, seed).sample(pool, parts))


def corpus_capacity(profile: str = DEFAULT_PROFILE) -> int:
    """Number of distinct bodies the profile can produce (ordered sequences).

    Used to fail LOUDLY rather than silently repeat a body -- a repeat is a
    cache hit waiting to happen.
    """
    buckets = [profile] if profile != "mixed" else [b for b, _ in MIXED_WEIGHTS]
    total = 0
    for b in buckets:
        n = len(SNIPPETS[b])
        k = min(PROFILE_PARTS[b], n)
        perms = 1
        for i in range(k):
            perms *= n - i
        total += perms
    return total


def corpus_series(profile: str, n: int, seed: int = 0) -> list:
    """``n`` PAIRWISE-DISTINCT request bodies -- the cache-defeat guarantee.

    Every request in an open-loop run gets its own text, so no request can be
    answered from the synthesis cache no matter what the server's cache policy
    is. Raises if the profile cannot supply ``n`` distinct bodies, instead of
    quietly handing back duplicates that would contaminate the measurement.
    """
    if n < 0:
        raise ValueError("n must be >= 0")
    cap = corpus_capacity(profile)
    if n > cap:
        raise ValueError(
            f"profile {profile!r} can produce at most {cap} distinct bodies, "
            f"{n} requested -- a repeated body could be served from the "
            f"synthesis cache and would not measure the model")
    out, seen, i = [], set(), 0
    # Bounded: each miss consumes one candidate seed, and the guard above
    # guarantees the space is large enough to finish.
    while len(out) < n:
        text = corpus_sample(profile, seed=(seed, i))
        i += 1
        if text in seen:
            continue
        seen.add(text)
        out.append(text)
    return out
