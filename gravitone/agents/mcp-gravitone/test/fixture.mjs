// A manifest exactly as GET /api/keys/{id}/manifest returns one, for a key
// holding `tts` and `stt` only. The absences matter as much as the presences:
// there is no `perform` tool here because the key has no `performance` scope,
// and the tests below assert that stays true through every layer.

export function manifestFixture(overrides = {}) {
  return {
    manifest_version: 1,
    generated_at: "2026-07-30T12:00:00.000Z",
    base_url: "https://voice.example.com",
    auth: { header: "xi-api-key", alternate: "Authorization: Bearer <key>", note: "…" },
    key: { id: "k1", name: "Agent key", prefix: "gvt_abc", scopes: ["tts", "stt"], revoked: false },
    boundary: "…",
    proof: { source: "none", note: "…" },
    uncovered_scopes: [],
    tools: [
      {
        id: "speak",
        scope: "tts",
        summary: "Synthesize speech from text with one voice.",
        method: "POST",
        endpoint: "/v1/text-to-speech/{voice_id}",
        params: [
          { name: "voice_id", in: "path", type: "string", required: true, description: "A voice id." },
          { name: "text", in: "body", type: "string", required: true, description: "The text to speak." },
          { name: "output_format", in: "query", type: "string", required: false, description: "Audio encoding." },
        ],
        response: { kind: "audio", description: "Audio bytes." },
        notes: ["CPU-bound."],
        proven: "unknown",
      },
      {
        id: "list_voices",
        scope: "tts",
        summary: "List the voices this deployment can speak with.",
        method: "GET",
        endpoint: "/v1/voices",
        params: [],
        response: { kind: "json", description: "{ voices: [] }" },
        notes: [],
        proven: "true",
      },
      {
        id: "transcribe",
        scope: "stt",
        summary: "Transcribe a recording.",
        method: "POST",
        endpoint: "/v1/speech-to-text",
        params: [
          { name: "file", in: "file", type: "string", required: true, description: "The recording." },
          { name: "diarize", in: "body", type: "boolean", required: false, description: "Split by speaker." },
        ],
        response: { kind: "json", description: "{ text }" },
        notes: [],
        proven: "false",
      },
    ],
    ...overrides,
  };
}

/** A fetch stub that answers from a table and records what it was asked. */
export function stubFetch(answer) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const r = answer(String(url), init);
    if (r instanceof Error) throw r;
    return r;
  };
  impl.calls = calls;
  return impl;
}

export function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
