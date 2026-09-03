"""The speech engine plane: what each mouth can do, and which one speaks.

This service has had two engines since Piper landed, and exactly one place that
knew it: a private four-rule `if` in `service/convai.py` plus an `is_piper`
boolean threaded through the session. That is a router in disguise. It works,
but nothing can ASK it anything -- an operator cannot see which engines exist,
what they can do, or why a Czech agent refused, and a third engine would mean
editing the same `if` again.

This module is that router, made explicit, in three parts:

  * `EngineCapabilities` -- what an engine DECLARES: languages, cloning,
    emotion, native rate, licence, and how to install it. Frozen, because a
    capability that can be mutated at runtime is not a claim anyone can hold an
    adapter to.
  * `resolve(language, voice_id)` -- the SAME four rules convai has always run,
    with the SAME authored refusal text. `test_piper.VoiceResolutionTests` is
    its specification and passes against this module unmodified; convai keeps
    `_resolve_voice` as a thin re-export so every existing caller (the agents
    surface, the session, the polyglot mid-call switch) is unchanged.
  * The two real adapters, `pocket-tts` and `piper`, each answering
    `capabilities()` / `list_voices()` / `synthesize_pcm()` / `synthesize_wav()`
    -- and `service/tests/engine_conformance.py`, one parameterized suite both
    of them must pass.

**Declared is not proven.** `capabilities()` is what an adapter says about
itself; the conformance suite is what it has been shown to do. `GET /v1/engines`
reports both, separately, and reports absence as absence -- an unmeasured native
rate is `null`, never a plausible-looking number. That is also why
`native_rate` for Pocket TTS is null here: the rate belongs to the model on
disk, this process cannot know it without synthesizing, and the honest answer
before the first synthesis is "not measured". Once something HAS synthesized,
the observed rate appears under `proven`.

**Registration is live, not a list.** Piper's languages come from
`piper.list_voices()` (a voice is two files on disk), so downloading a Czech
voice changes this surface with no restart and no code change. Pocket TTS's
languages are the one genuinely hardcoded fact in the plane -- they are a
property of the shipped model, not of anything on disk -- and they live here
now, with convai re-exporting the name it used to own.

**Dispatch has NOT moved.** Routing the request path through the adapters is a
later step; `convai._Session` still calls the pool and `piper` directly. What is
true today is that the adapters are real, the rules have one home, and both
engines are held to one behavioural contract.
"""
from __future__ import annotations

import io
import json
import logging
import threading
import wave
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, NamedTuple, Protocol, runtime_checkable

from fastapi import APIRouter

from service import piper
from service.config import SETTINGS

logger = logging.getLogger("gravitone.engines")

# The engine plane's OWN router. Mounted by service/app.py (which this module
# must never import -- app imports convai, convai imports this).
router = APIRouter(tags=["engines"])

POCKET = "pocket-tts"
PIPER = "piper"

# Languages Pocket TTS can actually speak. This is the fact rule 3 turns on:
# anything outside it needs a Piper voice or the agent is refused. It lived in
# convai.py as `_POCKET_LANGUAGES` and is re-exported there under that name.
POCKET_LANGUAGES = frozenset({"en", "fr"})


# ---------------------------------------------------------------------------
# What an engine declares
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class EngineCapabilities:
    """One engine's claims about itself. Frozen: a claim must be quotable.

    ``native_rate`` is ``None`` when this process cannot know it without
    synthesizing -- absent, not guessed. ``concurrency`` is how many syntheses
    the adapter permits at once inside this process; the conformance suite
    drives more than that through it and asserts the bound held, which is what
    keeps two engines from quietly doubling the CPU budget.
    """

    engine_id: str
    languages: tuple[str, ...]
    clones: bool
    emotions: bool
    native_rate: int | None
    license: str
    install_hint: str
    concurrency: int = 1

    def as_dict(self) -> dict:
        return {"engine_id": self.engine_id, "languages": list(self.languages),
                "clones": self.clones, "emotions": self.emotions,
                "native_rate": self.native_rate, "license": self.license,
                "install_hint": self.install_hint,
                "concurrency": self.concurrency}


class VoiceUnavailable(RuntimeError):
    """The agent names a voice this replica cannot speak. Authored for the
    operator: the message says exactly what to download."""


class Resolution(NamedTuple):
    """``(engine_id, voice_id)`` -- which mouth, and which voice in it."""

    engine_id: str
    voice_id: str


@runtime_checkable
class SpeechEngine(Protocol):
    """What every adapter must answer. Forty lines is the whole obligation."""

    def capabilities(self) -> EngineCapabilities: ...

    def list_voices(self) -> list[str]: ...

    def synthesize_pcm(self, voice_id: str, text: str) -> tuple[bytes, int]: ...

    def synthesize_wav(self, voice_id: str, text: str) -> tuple[bytes, int]: ...


# ---------------------------------------------------------------------------
# The rule
# ---------------------------------------------------------------------------
def resolve(language: str, voice_id: str = "", *, agent_id: str = "") -> Resolution:
    """Which engine speaks this, and with which voice.

    The rule, in order:

      1. An explicitly named Piper voice wins -- the operator was specific.
      2. Any other explicitly named voice goes to the Pocket TTS pool.
      3. Otherwise, if the LANGUAGE is one Pocket TTS cannot speak, find a Piper
         voice for it. This is what lets a Czech agent be configured with
         nothing but ``"language": "cs"``.
      4. Otherwise the service default.

    Rule 3 is the one that matters. Without it a Czech agent fell through to an
    English voice and read Czech words with English phonemes -- a conversation
    that "worked" and was unlistenable, which is worse than one that refuses.

    ``agent_id`` only names the subject of the refusal; resolution itself does
    not depend on it, so a caller resolving a bare language may omit it.
    """
    named = (voice_id or "").strip()
    if named:
        return Resolution(PIPER if piper.has_voice(named) else POCKET, named)

    language = (language or "en").split("-", 1)[0].lower()
    if language not in POCKET_LANGUAGES:
        found = piper.voice_for_language(language)
        if found:
            return Resolution(PIPER, found)
        raise VoiceUnavailable(_unspeakable(language, agent_id))
    return Resolution(POCKET, SETTINGS.default_voice)


def _unspeakable(language: str, agent_id: str) -> str:
    """The authored refusal, word for word as convai has always raised it.

    Word for word matters: it is the one message an operator sees when a
    conversation will not start, and it is the only place the download command
    is written down. The subject is generalized (a caller resolving a bare
    language is not an agent) and is IDENTICAL for every agent-shaped call.
    """
    subject = f"agent '{agent_id}'" if agent_id else "this replica"
    return (
        f"{subject} speaks {language!r}, which Pocket TTS "
        f"cannot synthesize (it speaks {sorted(POCKET_LANGUAGES)}), and no "
        f"Piper voice for {language!r} is installed. Download one into "
        f"{piper.voices_dir()} — e.g. `python -m piper.download_voices "
        f"--download-dir {piper.voices_dir()} cs_CZ-jirka-medium` — or give "
        "the agent an explicit voice_id.")


# ---------------------------------------------------------------------------
# Adapters
# ---------------------------------------------------------------------------
# What each engine has actually produced in this process, engine_id -> rate.
# PROVEN, as opposed to the declared `native_rate`: only written by a synthesis
# that really happened, and reported separately for exactly that reason.
_OBSERVED_RATE: dict[str, int] = {}


def _observe(engine_id: str, rate: int) -> None:
    if rate and rate > 0:
        _OBSERVED_RATE[engine_id] = int(rate)


def observed_rate(engine_id: str) -> int | None:
    return _OBSERVED_RATE.get(engine_id)


def _silence(rate: int) -> tuple[bytes, int]:
    """Empty text is silence, not an error -- the shape both adapters return."""
    return b"", rate


def _wrap_wav(pcm: bytes, rate: int) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm)
    return buf.getvalue()


def _unwrap_wav(wav_bytes: bytes) -> tuple[bytes, int]:
    with wave.open(io.BytesIO(wav_bytes), "rb") as w:
        return w.readframes(w.getnframes()), w.getframerate()


class PiperEngine:
    """Piper voices: many languages, fixed voices, no cloning, MIT.

    A thin adapter over ``service/piper.py`` on purpose -- the module already
    owns discovery, the bounded voice cache and the single run lock, and an
    adapter that re-implemented any of that would be a second opinion about the
    same files.
    """

    engine_id = PIPER

    def capabilities(self) -> EngineCapabilities:
        voices = piper.list_voices()
        return EngineCapabilities(
            engine_id=PIPER,
            # LIVE: downloading a voice adds its language here, no restart.
            languages=tuple(sorted({v.language for v in voices})),
            clones=False,          # fixed voices; cloning is Pocket TTS's job
            emotions=False,        # no emotion scale, no metatag vocabulary
            native_rate=self._declared_rate(voices),
            license="MIT",
            install_hint=(f"download a voice into {piper.voices_dir()} with "
                          "`python -m piper.download_voices --download-dir "
                          f"{piper.voices_dir()} <voice>` (needs `pip install "
                          "piper-tts`)"),
            # service/piper.py holds ONE process-wide run lock, deliberately:
            # the core budget is already pinned to the Pocket TTS workers.
            concurrency=1,
        )

    @staticmethod
    def _declared_rate(voices: list) -> int | None:
        """The rate every installed voice agrees on, or None.

        Piper writes the rate into the ``.onnx.json`` beside the model, so this
        is read rather than assumed. Voices that disagree (a 16 kHz next to a
        22.05 kHz one) have no single native rate, and saying so is the honest
        answer -- as is a config this cannot parse.
        """
        rates: set[int] = set()
        for info in voices:
            try:
                config = json.loads(
                    Path(str(info.path) + ".json").read_text("utf-8"))
                rate = int(config["audio"]["sample_rate"])
            except (OSError, ValueError, TypeError, KeyError):
                return None
            rates.add(rate)
        return rates.pop() if len(rates) == 1 else None

    def list_voices(self) -> list[str]:
        return [v.voice_id for v in piper.list_voices()]

    def synthesize_pcm(self, voice_id: str, text: str) -> tuple[bytes, int]:
        pcm, rate = piper.synthesize_pcm(voice_id, text)
        _observe(PIPER, rate if pcm else 0)
        return pcm, rate

    def synthesize_wav(self, voice_id: str, text: str) -> tuple[bytes, int]:
        wav, rate = piper.synthesize_wav(voice_id, text)
        return wav, rate


# How the Pocket TTS adapter reaches the worker pool. Set by an orchestrator (or
# a test) that owns the pool; otherwise the adapter falls back to the provider
# convai was already handed, imported lazily because convai imports THIS module.
_pool_provider: Callable[[], object | None] | None = None


def set_pool_provider(provider: Callable[[], object | None] | None) -> None:
    """Hand the adapter its pool. ``None`` restores the convai fallback."""
    global _pool_provider
    _pool_provider = provider


def _pool():
    if _pool_provider is not None:
        return _pool_provider()
    from service import convai  # lazy: convai imports this module
    return convai._engine_provider()


class PocketEngine:
    """Pocket TTS: the product. English/French, cloning, emotion voices.

    Synthesis goes through the SAME worker pool every HTTP route uses rather
    than a second model load -- the pool IS the CPU budget, and an adapter that
    loaded its own copy would be the contention this plane exists to prevent.
    """

    engine_id = POCKET

    def capabilities(self) -> EngineCapabilities:
        return EngineCapabilities(
            engine_id=POCKET,
            languages=tuple(sorted(POCKET_LANGUAGES)),
            clones=True,           # zero-shot cloning: the reason this exists
            emotions=True,         # the emotion scale + metatag grammar
            # NOT a guess: the rate belongs to the model on disk and this
            # process cannot know it until something has synthesized. See
            # `proven` in the /v1/engines report.
            native_rate=None,
            license="pocket-tts model licence (see the appliance manifest)",
            install_hint=("built in -- clone a voice with POST /v1/voices, or "
                          "list what is already installed with GET /v1/voices"),
            concurrency=self._workers(),
        )

    @staticmethod
    def _workers() -> int:
        """The pool's own parallelism, which IS this adapter's bound.

        Everything is inside the guard, the lookup included: the boot
        declaration check runs while ``service.convai`` is still executing its
        own import (convai imports this module), so reaching for the pool there
        raises rather than returns None. 1 is the right answer to "how many
        syntheses may run at once" when this process cannot find out -- an
        engine that cannot see its budget must not claim a large one.
        """
        try:
            return max(1, int(_pool().config().get("workers", 1)))
        except Exception:  # noqa: BLE001 - no pool, or a pool that cannot say
            return 1

    def list_voices(self) -> list[str]:
        """Every voice in the registry. Imported lazily: service/voices.py pulls
        in the clone/export stack, which this module must not require just to
        describe an engine."""
        try:
            from service import voices
            return [v.voice_id for v in voices.all_voices()]
        except Exception as exc:  # noqa: BLE001 - describing an engine must
            # never fail because the voice registry is unreadable; the registry
            # routes report that problem properly, in their own words.
            logger.warning("pocket-tts: could not list voices (%s)", exc)
            return []

    def synthesize_wav(self, voice_id: str, text: str) -> tuple[bytes, int]:
        text = (text or "").strip()
        if not text:
            pcm, rate = _silence(SETTINGS.convai_audio_rate)
            return _wrap_wav(pcm, rate), rate
        known = self.list_voices()
        if known and voice_id not in known:
            raise VoiceUnavailable(
                f"no Pocket TTS voice '{voice_id}'. Installed: "
                f"{', '.join(sorted(known)) or 'none'}. Clone one with "
                "`POST /v1/voices` (a recording plus an ownership attestation) "
                "or list them with `GET /v1/voices`.")
        pool = _pool()
        if pool is None:
            raise RuntimeError("the synthesis engine is not running")
        job = pool.submit(voice_id=voice_id, text=text, overrides={})
        result = job.future.result(timeout=SETTINGS.request_timeout_s)
        _observe(POCKET, result.sample_rate)
        return result.wav_bytes, int(result.sample_rate)

    def synthesize_pcm(self, voice_id: str, text: str) -> tuple[bytes, int]:
        wav, rate = self.synthesize_wav(voice_id, text)
        pcm, wav_rate = _unwrap_wav(wav)
        return pcm, wav_rate or rate


# ---------------------------------------------------------------------------
# The registry
# ---------------------------------------------------------------------------
_ENGINES: dict[str, SpeechEngine] = {POCKET: PocketEngine(), PIPER: PiperEngine()}


def engines() -> dict[str, SpeechEngine]:
    """Every adapter this replica has, by id. A copy: the plane is not editable
    through a reference somebody kept."""
    return dict(_ENGINES)


def get(engine_id: str) -> SpeechEngine | None:
    return _ENGINES.get(engine_id)


def capabilities() -> list[EngineCapabilities]:
    """What every engine declares, right now (Piper's is read from disk)."""
    return [_ENGINES[eid].capabilities() for eid in sorted(_ENGINES)]


# ---------------------------------------------------------------------------
# Conformance: declared at boot, behavioural from the suite
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class ConformanceReport:
    engine_id: str
    level: str            # "declaration" (boot) | "behavioural" (the suite)
    passed: bool
    checked: int
    problems: tuple[str, ...]
    at: str

    def as_dict(self) -> dict:
        return {"level": self.level, "passed": self.passed,
                "checked": self.checked, "problems": list(self.problems),
                "at": self.at}


_CONFORMANCE: dict[str, ConformanceReport] = {}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace(
        "+00:00", "Z")


def check_declaration(engine: SpeechEngine) -> tuple[int, list[str]]:
    """The cheap half: is this engine's manifest even well formed?

    Runs at import, so it must touch nothing but the declaration itself -- no
    filesystem beyond what `capabilities()` already reads, no model, no
    registry. Everything behavioural (does it really speak that language, does
    it really run one synthesis at a time) belongs to
    `service/tests/engine_conformance.py`, which needs fixtures this cannot
    have at boot.
    """
    problems: list[str] = []
    caps = engine.capabilities()
    checks = 0

    checks += 1
    if not caps.engine_id or caps.engine_id != getattr(engine, "engine_id", None):
        problems.append("engine_id does not match the adapter's own id")

    checks += 1
    for tag in caps.languages:
        if not (isinstance(tag, str) and tag.isalpha() and tag.islower()
                and 2 <= len(tag) <= 3):
            problems.append(f"{tag!r} is not a bare lowercase language tag")

    checks += 1
    if caps.native_rate is not None and caps.native_rate <= 0:
        problems.append("native_rate must be a real rate or absent, never zero")

    checks += 1
    if not caps.license.strip():
        problems.append("an engine must declare its licence (licence mixing is "
                        "a refusable condition, so it has to be stated)")

    checks += 1
    if not caps.install_hint.strip():
        problems.append("an engine must say how it is installed")

    checks += 1
    if caps.concurrency < 1:
        problems.append("concurrency must be at least 1")

    return checks, problems


def record_conformance(engine_id: str, *, level: str, passed: bool,
                       checked: int, problems: tuple[str, ...] = ()) -> None:
    """Publish a conformance result for ``engine_id``.

    The seam the conformance suite writes through, so `GET /v1/engines` can
    report which adapters have actually been PROVEN rather than only described.
    A behavioural result outranks the boot declaration check and replaces it.
    """
    _CONFORMANCE[engine_id] = ConformanceReport(
        engine_id=engine_id, level=level, passed=passed, checked=checked,
        problems=tuple(problems), at=_now())


def conformance(engine_id: str) -> ConformanceReport | None:
    return _CONFORMANCE.get(engine_id)


def verify_at_boot() -> None:
    """Check every adapter's declaration and record the result.

    Called once at import. A failure here is logged and recorded, NOT raised:
    an engine with a malformed manifest must be visibly non-conformant on
    /v1/engines rather than able to prevent the service from starting.
    """
    for engine_id, engine in _ENGINES.items():
        try:
            checked, problems = check_declaration(engine)
        except Exception as exc:  # noqa: BLE001 - a broken adapter is a finding
            record_conformance(engine_id, level="declaration", passed=False,
                               checked=0, problems=(f"{type(exc).__name__}: {exc}",))
            logger.error("engine '%s' could not describe itself: %s", engine_id, exc)
            continue
        record_conformance(engine_id, level="declaration", passed=not problems,
                           checked=checked, problems=tuple(problems))
        if problems:
            logger.error("engine '%s' failed its declaration check: %s",
                         engine_id, "; ".join(problems))


verify_at_boot()


# ---------------------------------------------------------------------------
# HTTP surface
# ---------------------------------------------------------------------------
@router.get("/v1/engines")
def list_engines() -> dict:
    """Every engine on this replica: what it claims, and what it has proven.

    Three things are deliberately separate here. ``capabilities`` is what the
    adapter DECLARES. ``proven`` is what has actually been observed in this
    process (a sample rate appears only after a real synthesis; before that it
    is null, because "not measured" and "24 kHz" are different answers).
    ``conformance`` is which suite the adapter has passed -- at boot every
    engine has only had its manifest checked, and saying "declaration" rather
    than a bare green tick is the difference between a claim and a proof.

    ``resolution`` publishes the routing rule itself, because an operator
    looking at a refused agent needs to know that a language Pocket TTS cannot
    speak requires an installed Piper voice, and where to put it.
    """
    described = []
    for caps in capabilities():
        engine = _ENGINES[caps.engine_id]
        report = _CONFORMANCE.get(caps.engine_id)
        described.append({
            "capabilities": caps.as_dict(),
            "voices": sorted(engine.list_voices()),
            "proven": {"sample_rate": observed_rate(caps.engine_id)},
            "conformance": report.as_dict() if report else None,
        })
    return {
        "engines": described,
        "resolution": {
            "default_voice": SETTINGS.default_voice,
            "pocket_languages": sorted(POCKET_LANGUAGES),
            "rules": [
                "an explicitly named Piper voice wins",
                "any other explicitly named voice goes to Pocket TTS",
                "otherwise a language Pocket TTS cannot speak needs a Piper "
                "voice for it",
                "otherwise the service default voice",
            ],
        },
    }
