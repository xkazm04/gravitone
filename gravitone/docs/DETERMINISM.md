# The determinism contract

What Gravitone promises about repeating a synthesis, and — just as importantly —
what it does not. Written because the product makes a claim about emotion being
*auditioned rather than rolled*, and a claim like that is worth exactly as much
as the part of it that is true.

The executable half of this document is
`service/tests/test_determinism.py`. Every promise below is asserted there; every
non-promise is asserted there too, so nobody can quietly upgrade a
"probably" into a "guaranteed".

## The short version

| Question | Answer |
|---|---|
| Does the same request return the same bytes? | **Yes, while the render is held** — see *Replay*. |
| Does the same request *re-rendered from scratch* return the same bytes? | **No.** See *What is not deterministic*. |
| Does `(character, emotion)` always select the same Voice? | **Yes**, and it is a pure function. |
| Do the sampling knobs vary per request? | **No.** They are a fixed function of what the caller sent. |
| Is there a seed parameter? | **No**, and there is deliberately not a fake one. |

## What IS deterministic

### 1. Emotion resolution is a pure function

`service/emotions.py::resolve` maps a requested emotion to a concrete
`voice_id`. Given the same Character state it returns the same
`(voice_id, used_emotion, fell_back)` every time — including the fallback walk
(exact slot → derived slot → measured-nearest → adjacent → baseline →
scale-first). It reads no clock, no RNG and no request context, and it does not
depend on dictionary iteration order: `deterministic_fallback` and
`nearest_measured` both break ties on `EMOTION_SCALE` position and then on name.

This is the load-bearing one for the emotion claim. **An emotion in Gravitone is
not a temperature and not a prompt — it is a different embedding**, recorded (or
explicitly derived and badged as such). Asking for `sarah:angry` twice cannot
select two different voices, because the selection is arithmetic over the
registry rather than a suggestion to a model.

### 2. The sampling knobs are a fixed function of the request

`service/app.py::_overrides` maps the ElevenLabs-shaped `VoiceSettings` onto the
model's three real knobs (`temperature → temp`, `stability → noise_clamp`,
`quality → lsd_decode_steps`). It is pure: same settings in, same overrides out,
with no per-request jitter, no time input and no randomness. Settings the engine
cannot honestly honour (`similarity_boost`, `style`) are inert and reported via
`X-Ignored-Settings` rather than being secretly mapped onto something else.

So "the same request" is a well-defined thing here — nothing in the service
perturbs a request on its way to the model.

### 3. Replay: an identical request returns identical bytes while it is held

`service/cache.py` keys a bounded LRU on everything that can change the audio
(`service/app.py::_cache_key`: the *resolved* voice id, a fingerprint of that
voice's `.safetensors`, the verbatim text, the effective overrides,
`frames_after_eos`, and the process-wide generation/model identity). A repeat
request is served the **same bytes**, not a fresh render, and says so in
`X-Cache: hit`. Concurrent identical requests collapse onto one render
(`X-Cache: collapsed`) rather than each rolling their own.

This is what makes the studio's audition and A/B surfaces meaningful: the takes
a user compares are *artefacts*, rendered once and then replayed, so pressing
play twice cannot change what they hear.

Scope, stated plainly, because it is a cache and not a promise engraved in
stone:

- **Per process.** The service ships as N single-worker replicas
  (`service/replicas.py`), each with its own cache. A hit in one is not a hit in
  another.
- **Bounded and evictable.** `TTS_CACHE_BYTES` decides how much is held; past
  that the least-recently-used render is dropped.
- **Not persisted.** A restart starts cold.
- **Opt-out-able.** `Cache-Control: no-store` or `X-Gravitone-Cache: bypass`
  re-renders on purpose (this is what the load-test harness uses so it measures
  synthesis rather than an LRU lookup).

Once an entry is gone, the next request is a *fresh render*, and the next
section applies.

### 4. Voice identity invalidates its own audio

The cache key folds in the `.safetensors` mtime+size, so re-cloning a Voice
cannot serve audio rendered from the previous embedding. Determinism here never
becomes staleness.

## What is NOT deterministic

**A cold re-render of the same request is not byte-identical, and Gravitone does
not claim it is.**

Pocket TTS samples: `service/engine.py::_Worker._generate` calls
`model.generate_audio(state, text, max_tokens=…, frames_after_eos=…,
copy_state=True)` with a `temp` (default 0.7) that is a sampling temperature.
Nothing in this repository seeds a random number generator on the synthesis
path — there is no `torch.manual_seed`, no `seed` field on `TTSRequest`, and no
`seed` on `engine.Job`. Two renders of one input will therefore differ at the
sample level.

### Why a seed knob was not added

It would have been three lines (`torch.manual_seed(job.seed)` before the
generate call), and it was rejected rather than shipped, for two reasons:

1. **It would be a claim we cannot substantiate here.** Whether
   `generate_audio` draws exclusively from torch's default generator — as
   opposed to any other source of entropy inside the model — is a property of
   the model package, not of this service. Shipping a `seed` parameter that
   *usually* reproduces audio is worse than shipping none: callers would build
   on a guarantee that silently does not hold.
2. **It would not be safe at `TTS_WORKERS > 1`.** Torch's default CPU generator
   is process-global, not thread-local, while the worker pool is threads inside
   one process. Seeding it per job means two concurrent jobs interleave their
   draws, so the "same seed → same audio" property would hold at one worker and
   quietly stop holding at two — a guarantee that depends on an env var is not a
   guarantee.

If a future model exposes a per-call generator (or the service moves to
process-per-worker), this is the place to revisit: add the seed to
`engine.Job`, thread it through `_generate`, add it to `_cache_key`, and replace
this section with a test that renders twice with the cache bypassed and asserts
the hashes match.

## What the tests assert

`service/tests/test_determinism.py`, in order of what each pins:

1. `resolve` is pure and order-independent — repeated calls and a permuted
   Character mapping give an identical answer, on both the exact-hit and the
   fallback paths.
2. Distinct emotions of one Character select **distinct** voices, so an audition
   of the scale is genuinely N different recordings and not one take under N
   labels.
3. `_overrides` is pure, carries no seed-shaped field, and is unchanged by the
   inert compatibility settings.
4. **The negative control**: the fake engine used by the suite returns
   *different* bytes for every render. This is asserted first, so the byte
   equality below cannot pass vacuously.
5. Two identical HTTP requests return **byte-identical** audio and cause exactly
   one render (`X-Cache: miss` then `hit`).
6. Two identical requests differing only in an inert setting are still
   byte-identical.
7. The same emotion address twice is byte-identical; two different emotion
   addresses are not.
8. **The honest boundary**: a request that bypasses the cache re-renders, is
   reported as a bypass, and is *allowed* to differ — the test asserts the
   re-render happened rather than asserting the bytes match, because asserting
   the match is the lie this document exists to avoid.
