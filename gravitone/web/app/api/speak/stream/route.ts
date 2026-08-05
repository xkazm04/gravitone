// Streaming solo synthesis — the relay that lets a take start playing before
// it has finished being made.
//
// The service has offered `POST /v1/text-to-speech/{voice_id}/stream` all
// along: it submits the script's sentences to the worker pool in a rolling
// window and writes each segment's samples out as it finishes, so time to
// first audio is first-SEGMENT time rather than whole-body time. The studio
// never used it, and shipped an apology instead — a ticking clock and an RTF
// estimate for a wait it could have simply made shorter.
//
// THREE things this route is not, each on purpose:
//
//   * it is not /api/speak with a flag. `/v1/speak` compiles inline [emotion]
//     tags into one job per emotion span; the streaming endpoint has NO metatag
//     grammar at all (service/app.py::_split_sentences says so) and renders the
//     whole text in the one voice it was addressed with. Streaming a tagged
//     take would therefore return audio that silently ignored every tag in it.
//     lib/engineSeam decides eligibility and only untagged solo takes get here;
//     this route addresses `{character_id}:baseline` and nothing else.
//
//   * it does not choose a format. It pins `pcm_24000` because the caller
//     decodes PCM16 frames itself and masters the finished WAV in the browser.
//     `wav_*` would prepend a streaming WAV header with a 32-bit-max length
//     that the studio would then have to strip back off, and `mp3_*` is a 501
//     upstream (transcoding needs the whole clip).
//
//   * it does not buffer. lib/backend#proxyAudioPost hands the upstream body
//     through as a stream; anything that reads it whole first turns this back
//     into /api/speak with extra steps.
//
// Refusals, backpressure and the exposed timing headers are the shared relay's,
// so a 429 here is the same 429 (Retry-After included) the buffered path emits.
//
// WHY NOT `<audio src="...">`, the obvious way to play a stream progressively:
// a media element issues its own GET, and a solo take's request is a POST body
// (up to 8000 characters of script plus the expression knobs). Moving that into
// a URL puts it in the request LINE, which Node caps with the rest of the
// headers at 16 KB — a long take would 431 instead of playing. MediaSource,
// which would let a fetch feed an element, supports neither wav nor raw PCM.
// So the browser decodes and schedules the frames itself
// (_variants/engine::createStreamPlayer), which is the shape the live
// conversation client already uses for exactly these bytes.

import { NextRequest } from "next/server";

import { jsonError, proxyAudioPost, readCappedText } from "@/lib/backend";

/** The service's own text cap for one synthesis request (SpeakRequest). */
const MAX_TEXT = 8000;

export async function POST(req: NextRequest) {
  const raw = await readCappedText(req);
  if (raw instanceof Response) return raw;

  let body: { character_id?: unknown; text?: unknown; voice_settings?: unknown };
  try {
    body = JSON.parse(raw);
  } catch {
    return jsonError("body must be JSON", 400);
  }

  const characterId = typeof body.character_id === "string" ? body.character_id.trim() : "";
  const text = typeof body.text === "string" ? body.text.trim() : "";
  // Refused HERE rather than upstream: the voice address is built from
  // character_id, and an empty or path-shaped one must never become a URL
  // segment addressed at the engine.
  if (!characterId || characterId.includes("/") || characterId.includes(":")) {
    return jsonError("character_id is required and may not contain ':' or '/'", 400);
  }
  if (!text) return jsonError("text is required", 400);
  if (text.length > MAX_TEXT) return jsonError("text is too long", 413);

  // `{character_id}:baseline` is the emotion-addressing form the service reads
  // (app.py::_resolve_emotion_address). Baseline explicitly, because this route
  // only ever carries text that has no emotion tags to honour — see the header.
  const address = encodeURIComponent(`${characterId}:baseline`);
  return proxyAudioPost(
    `/v1/text-to-speech/${address}/stream?output_format=pcm_24000`,
    JSON.stringify({
      text,
      ...(body.voice_settings ? { voice_settings: body.voice_settings } : {}),
    }), { credential: "operator" },
  );
}
