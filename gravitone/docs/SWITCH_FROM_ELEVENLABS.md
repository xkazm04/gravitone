# Switch from ElevenLabs in 5 minutes

Gravitone speaks the ElevenLabs HTTP API. Migrating an existing integration is
a **base-URL change** — same paths, same `xi-api-key` header, same request
body. Your voices change (they are yours, cloned from your own recordings);
your code mostly does not.

Everything on this page is enforced by
[`service/tests/test_compat.py`](../service/tests/test_compat.py). The
`ELEVENLABS_BODY` fixture at the top of that file is literally the body an
unmodified ElevenLabs SDK sends, and the suite fails if any field in it starts
returning a 422 or stops being reported.

---

## 1. Point the SDK somewhere else

You need a running Gravitone deployment and, if it was started with
`TTS_API_KEY` set, a key. (With `TTS_API_KEY` unset the service is open and the
header is ignored — see the posture notice on the studio's API-keys page.)
Below, `$GRAVITONE` is your base URL and `$KEY` is your key.

### curl

```bash
# was: https://api.elevenlabs.io/v1/text-to-speech/...
curl -X POST "$GRAVITONE/v1/text-to-speech/alba?output_format=mp3_44100_128" \
  -H "xi-api-key: $KEY" \
  -H "Content-Type: application/json" \
  -d '{"text": "Same request, no per-character bill."}' \
  --output speech.mp3
```

### Python — the official `elevenlabs` SDK

No code change beyond the constructor:

```python
from elevenlabs.client import ElevenLabs

client = ElevenLabs(
    api_key=KEY,
    base_url=GRAVITONE,       # <- the whole migration
)

audio = client.text_to_speech.convert(
    voice_id="alba",
    text="Same request, no per-character bill.",
    output_format="mp3_44100_128",
)
```

`client.text_to_speech.stream(...)` works too. Note what it returns here: its
default `output_format` is `mp3_44100_128`, and mp3 has no incremental
transcode, so you get the complete clip in one chunk rather than a progressive
stream. The response says so — `X-Stream: full-body` — and asking for
`output_format="pcm_24000"` gets you a genuinely progressive stream. See
[Streaming](#streaming) below.

### Python — plain `requests`

```python
import requests

r = requests.post(
    f"{GRAVITONE}/v1/text-to-speech/alba",
    params={"output_format": "mp3_44100_128"},
    headers={"xi-api-key": KEY},
    json={"text": "Same request, no per-character bill."},
)
r.raise_for_status()
open("speech.mp3", "wb").write(r.content)
```

### JavaScript

```js
// Run this SERVER-SIDE (Node, an edge function, your own API route).
// From a browser it needs TTS_CORS_ORIGINS to name your origin — CORS is
// closed by default, so the preflight fails before the key is ever sent.
const res = await fetch(
  `${GRAVITONE}/v1/text-to-speech/alba?output_format=mp3_44100_128`,
  {
    method: "POST",
    headers: { "xi-api-key": KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ text: "Same request, no per-character bill." }),
  },
);
const audio = await res.arrayBuffer();
```

## 2. Get your voice ids

```bash
curl -H "xi-api-key: $KEY" "$GRAVITONE/v1/voices"
```

ElevenLabs-shaped: `{"voices": [{voice_id, name, category, labels, …}]}`. The
built-ins are ordinary first names (`alba`, …). To add your own, clone from a
~16-second recording with `POST /v1/voices` (multipart) or the studio's voice
creation flow.

`labels` is computed from the voice's own row — `character`, `emotion`,
`language`, `origin`. Nothing is guessed: an ElevenLabs voice's labels often
carry `accent` / `age` / `gender`, and we do not know those about a cloned
voice, so those keys are absent rather than invented.

---

## What we honor

| You send | What happens |
|---|---|
| `text` | synthesized (1–8000 chars) |
| `voice_id` (path) | resolved; also accepts the Gravitone form `{character}:{emotion}` |
| `xi-api-key` header | checked when `TTS_API_KEY` is set. `Authorization: Bearer …` also works |
| `voice_settings.stability` | mapped to the model's noise clamp (`0` wild → `1` tight) |
| `output_format` query param | full grammar below |
| `If-None-Match` | `304` without synthesizing, against the `X-Speech-Digest` ETag |

### `output_format`

| Family | Accepted | Notes |
|---|---|---|
| `mp3_{22050\|24000\|44100}_{32\|64\|96\|128\|192}` | ✅ | transcoded by ffmpeg at that rate and bitrate |
| `pcm_{8000\|16000\|22050\|24000\|44100\|48000}` | ✅ | raw PCM16, `Content-Type: application/octet-stream`, rate echoed on `X-Sample-Rate` |
| `wav_{8000\|16000\|22050\|24000\|44100\|48000}` | ✅ | RIFF |
| bare `mp3` / `pcm` / `wav` | ✅ | default to 24000 (mp3 → 128 kbps) |
| anything else (`ogg_*`, `ulaw_*`, `flac`, an unlisted rate or bitrate) | **400** | the body lists exactly what IS supported |

Native synthesis is 24 kHz; any other rate is resampled (pcm/wav) or handed to
`ffmpeg -ar` (mp3). `wav_24000` — the default — is byte-identical to no
conversion at all. **An unsupported format is always a 400, never a silent
substitution**: you will never receive audio at a rate you did not ask for.

## What we accept and ignore

These are part of the ElevenLabs contract, so clients send them; there is no
honest knob here to map them onto. They are **typed and declared** on our
request model — so a stock SDK body is never a 422 — and every one you actually
send comes back named on the **`X-Ignored-Settings`** response header. A
parameter that quietly does nothing is a bug report waiting to happen, so this
header exists to make the no-op visible.

| Field | Why it is inert |
|---|---|
| `voice_settings.similarity_boost` | no reference-adherence knob in pocket-tts |
| `voice_settings.style` | no style-exaggeration knob |
| `voice_settings.use_speaker_boost` | no speaker-boost stage in this pipeline |
| `voice_settings.speed` | no rate control (resampling would change pitch, which is not what `speed` means) |
| `model_id` | one model; see `GET /v1/models` |
| `seed` | pocket-tts exposes no sampler seed. **Repeatability is available by another route:** `X-Speech-Digest` names the audio by its inputs, and `If-None-Match` returns the same bytes |
| `language_code` | one English model |
| `previous_text`, `next_text` | no cross-request prosody conditioning |
| `previous_request_ids`, `next_request_ids` | same, addressed by request id |
| `pronunciation_dictionary_locators` | no pronunciation dictionaries |
| `apply_text_normalization`, `apply_language_text_normalization` | normalization is fixed, not a per-request switch |
| `use_pvc_as_ivc` | no PVC/IVC distinction in our voices |

Unknown **query** parameters (`optimize_streaming_latency`, `enable_logging`)
are ignored outright and never fail a request.

## Streaming

`POST /v1/text-to-speech/{voice_id}/stream` — same path as ElevenLabs.

| `output_format` | Behavior |
|---|---|
| `pcm_*` | genuinely progressive: raw PCM16 chunks, sentence by sentence |
| `wav_*` | one streaming WAV header, then progressive PCM16 |
| `mp3_*` | **the complete clip in one body**, labelled `X-Stream: full-body` and `X-Stream-Fallback: <why>` |

The text is sentence-chunked and submitted in a rolling window, so
time-to-first-byte on `pcm_*`/`wav_*` drops to first-*segment* time rather than
full-synthesis time. mp3 cannot do that — the transcode needs the whole clip —
but `mp3_44100_128` is the ElevenLabs SDK's default for this endpoint, so
refusing it would break every unmodified `client.stream()` call on a base-URL
swap. It returns audio, and it tells you it was not incremental.

The genuinely-streaming formats carry no per-synthesis timing headers: HTTP
headers flush before synthesis finishes, so those numbers are not knowable yet.

`POST /v1/text-to-speech/{voice_id}/stream/with-timestamps` is an **alias** of
`/with-timestamps`, not a frame sequence: our alignment is obtained by feeding
the finished clip to a local transcriber, so there is nothing to emit until it
exists. Without a transcriber installed the route refuses by name (501) rather
than returning an invented timeline.

## What we deliberately don't support

| ElevenLabs surface | Here |
|---|---|
| `GET /v1/user`, `GET /v1/user/subscription` | **404, on purpose.** There is no credit meter to read, no `character_limit` to check before you call. Quota-guard code is the one thing you delete on the way over. What you get instead: `X-Audio-Seconds` on every response and real counters on `/metrics` |
| Pronunciation dictionaries | no endpoints, no locators |
| Dubbing, sound effects, audio isolation | not this service |
| Multiple / multilingual models | one model, English. `GET /v1/models` reports exactly that |
| `output_format` families `ogg_*`, `ulaw_*`, `alaw_*` | 400, listing the supported grammar |
| Determinism via `seed` | use `X-Speech-Digest` + `If-None-Match` instead (see above) |

CORS is **closed by default**. Browser-side calls need `TTS_CORS_ORIGINS` to
name your origin; server-to-server needs nothing. This is a deliberate posture,
not an oversight — the same box also mounts `/v1/keys` and `/v1/ingest`.

## What you get that ElevenLabs doesn't have

- **Emotion addressing.** `POST /v1/text-to-speech/{character}:{excited}` — one
  Character, many moods, with fallback reported on `X-Emotion-*`.
- **Multi-character scripts.** `POST /v1/performance`, one call, inline
  `[emotion]` metatags.
- **Real ops numbers.** `/metrics` reports in-flight, queue depth, latency
  percentiles and realtime factor. The studio renders them on `/ops`.
- **`X-Speech-Digest`.** Every piece of speech has a content-addressed public
  name; `GET /v1/audio/{digest}` fetches it back after a restart.

---

Compatibility matrix and the rest of the API: [`../README.md`](../README.md).
