// THE capability table — one typed list that the create bar, the per-key
// manifest route, the /.well-known document, the agent-config blocks and the
// in-repo MCP bridge all read from.
//
// It used to be a client-module constant (`data.ts::SCOPES`: id, label, hint),
// which meant a scope was a chip on a page and nothing else — no server route
// could import it (data.ts is "use client"), so anything machine-facing would
// have had to restate the scope→endpoint mapping and drift from it. This module
// is deliberately PURE: no "use client", no React, no fetch. data.ts re-exports
// `SCOPES` from here so the ledger's create bar is byte-identical.
//
// ── what a capability IS ─────────────────────────────────────────────────────
// One tool an agent can call, and the scope that grants it. Several capabilities
// may share a scope (`tts` grants both synthesis and the voice list, because
// GET /v1/voices sits behind require_read_write("tts", "voices") — its READ half
// is the tts scope). A scope the key does not hold contributes NO tools: absent
// is invisible, never a greyed-out entry an agent might plan around.
//
// ── keeping it honest ────────────────────────────────────────────────────────
// The endpoint/method/scope of every capability is asserted against a checked
// snapshot of the service's real routes (`serviceRoutes.ts`) by
// `capabilities.test.ts`. A manifest that promises an endpoint the service does
// not serve is worse than no manifest, so that test fails the suite with
// instructions rather than letting the drift ship.

/** A parameter of a tool call, in the shape both a JSON-Schema emitter and a
 *  human reading the table can use. `in` says where it goes on the wire. */
export type CapabilityParam = {
  name: string;
  in: "path" | "query" | "body" | "file";
  type: "string" | "number" | "boolean" | "object" | "array";
  required: boolean;
  description: string;
  /** Present only for enumerated values (output_format kinds, etc.). */
  enum?: readonly string[];
};

export type Capability = {
  /** Stable id, also the agent-facing tool name. */
  id: string;
  /** The key scope that grants it — one of `SCOPES`. */
  scope: string;
  /** One line an agent reads to decide whether this is the tool it wants. */
  summary: string;
  method: "GET" | "POST" | "PATCH" | "DELETE";
  /** Path template with `{param}` placeholders, exactly as the service mounts it. */
  endpoint: string;
  params: readonly CapabilityParam[];
  /** What comes back, in prose an agent can plan around. */
  response: { kind: "audio" | "json" | "empty"; description: string };
  /** Things that are true and would otherwise be discovered the hard way. */
  notes: readonly string[];
};

/** The grantable scopes, in the order `service/keys.py::SCOPES` lists them.
 *  `label`/`hint` are what the ledger's create bar renders. */
export type ScopeInfo = { id: string; label: string; hint: string };

export const SCOPES: readonly ScopeInfo[] = [
  { id: "tts", label: "Synthesize", hint: "generate speech" },
  { id: "voices", label: "Manage voices", hint: "rename / retag / delete" },
  { id: "clone", label: "Clone", hint: "upload & create voices" },
  { id: "performance", label: "Performance", hint: "multi-character scripts (/v1/performance) — the premium tier" },
  { id: "stt", label: "Transcribe", hint: "turn a recording into text (/v1/speech-to-text)" },
  { id: "convai", label: "Converse", hint: "hold a spoken conversation — listens and speaks (/v1/convai)" },
] as const;

/** Every audio format the service's `_parse_format` grammar accepts. Mirrored
 *  here (not fetched) so the well-known document answers without a live box;
 *  `serviceRoutes.ts` carries the same update-deliberately discipline. */
export const AUDIO_FORMATS = {
  grammar: "mp3_{sample_rate}_{bitrate} | pcm_{sample_rate} | wav_{sample_rate}, or the bare mp3 | pcm | wav",
  default: "wav_24000",
  native_sample_rate: 24000,
  mp3_sample_rates: [22050, 24000, 44100],
  mp3_bitrates: [32, 64, 96, 128, 192],
  pcm_sample_rates: [8000, 16000, 22050, 24000, 44100, 48000],
} as const;

const OUTPUT_FORMAT: CapabilityParam = {
  name: "output_format",
  in: "query",
  type: "string",
  required: false,
  description: `Audio encoding: ${AUDIO_FORMATS.grammar}. Defaults to ${AUDIO_FORMATS.default}; an unsupported value is a 400 that lists what is supported, never a silent fallback.`,
};

export const CAPABILITIES: readonly Capability[] = [
  {
    id: "speak",
    scope: "tts",
    summary: "Synthesize speech from text with one voice — the ElevenLabs drop-in route.",
    method: "POST",
    endpoint: "/v1/text-to-speech/{voice_id}",
    params: [
      { name: "voice_id", in: "path", type: "string", required: true, description: "A voice id from list_voices, or {character_id}:{emotion}." },
      { name: "text", in: "body", type: "string", required: true, description: "The text to speak (1–8000 characters)." },
      OUTPUT_FORMAT,
      { name: "emotion", in: "query", type: "string", required: false, description: "Gravitone extension: address a Character's emotion voice." },
    ],
    response: { kind: "audio", description: "Raw audio bytes in the requested format, with X-Audio-Seconds / X-Realtime-Factor timing headers." },
    notes: [
      "CPU-bound: a long text can hold a synth slot for minutes, and a busy box answers 429 with Retry-After.",
      "This is the only capability whose cost is real compute — the rest are reads or metadata writes.",
    ],
  },
  {
    id: "speak_as_character",
    scope: "tts",
    summary: "Speak metatagged text as one Character, switching voice per emotion.",
    method: "POST",
    endpoint: "/v1/speak",
    params: [
      { name: "character_id", in: "body", type: "string", required: true, description: "The Character to speak as." },
      { name: "text", in: "body", type: "string", required: true, description: 'Text with optional emotion metatags: "Hello. [excited]This is amazing![/excited]".' },
      OUTPUT_FORMAT,
    ],
    response: { kind: "audio", description: "Audio bytes; the per-segment substitution report is base64-JSON in the X-Segments header." },
    notes: ["Emotions the Character lacks fall back to its baseline voice — the report says which were substituted."],
  },
  {
    id: "list_voices",
    scope: "tts",
    summary: "List the voices this deployment can speak with.",
    method: "GET",
    endpoint: "/v1/voices",
    params: [],
    response: { kind: "json", description: "{ voices: [{ voice_id, name, ... }] } — ElevenLabs-shaped." },
    notes: [
      "Guarded by require_read_write(\"tts\", \"voices\"): the READ half is the tts scope, which is why a synthesis-only key can still discover voices.",
    ],
  },
  {
    id: "perform",
    scope: "performance",
    summary: "Render a multi-character script in one call — the premium surface.",
    method: "POST",
    endpoint: "/v1/performance",
    params: [
      { name: "lines", in: "body", type: "array", required: true, description: "1–64 lines of { character_id, text, voice_settings? }; text may carry emotion metatags." },
      OUTPUT_FORMAT,
    ],
    response: { kind: "audio", description: "One audio stream of the whole scene; the line/segment report is base64-JSON in X-Performance-Report." },
    notes: ["Requires the `performance` scope specifically — a tts-scoped key is refused here."],
  },
  {
    id: "transcribe",
    scope: "stt",
    summary: "Transcribe a recording — ElevenLabs Scribe-shaped.",
    method: "POST",
    endpoint: "/v1/speech-to-text",
    params: [
      { name: "file", in: "file", type: "string", required: true, description: "The recording to transcribe, uploaded as multipart/form-data." },
      { name: "language_code", in: "body", type: "string", required: false, description: "Whisper's TWO-letter code (\"en\"), not Scribe's three-letter one." },
      { name: "diarize", in: "body", type: "boolean", required: false, description: "Split by speaker. Boundaries are dependable; the speaker COUNT skews high." },
    ],
    response: { kind: "json", description: "{ text, words[], diarization? } — Scribe-shaped, with a diarization block that states how far to trust itself." },
    notes: [
      "model_id is accepted for drop-in compatibility and IGNORED — which model runs is the replica's STT_MODEL.",
      "Uploads are capped; an oversized recording is a 413, not a truncated transcript.",
    ],
  },
  {
    id: "update_voice",
    scope: "voices",
    summary: "Rename or retag a voice.",
    method: "PATCH",
    endpoint: "/v1/voices/{voice_id}",
    params: [
      { name: "voice_id", in: "path", type: "string", required: true, description: "The voice to update." },
      { name: "name", in: "body", type: "string", required: false, description: "New display name." },
      { name: "labels", in: "body", type: "object", required: false, description: "Metadata labels to merge." },
    ],
    response: { kind: "json", description: "The updated voice." },
    notes: ["The WRITE half of require_read_write(\"tts\", \"voices\") — a tts-only key can read voices but never change them."],
  },
  {
    id: "list_ingest_modes",
    scope: "clone",
    summary: "List the cloning/ingest modes this deployment offers.",
    method: "GET",
    endpoint: "/v1/ingest/modes",
    params: [],
    response: { kind: "json", description: "The ingest modes and what each needs." },
    notes: [
      "The read that proves the clone scope. Actually creating a voice is a multi-step ingest job, deliberately NOT exposed as a one-shot agent tool.",
    ],
  },
  {
    id: "list_agents",
    scope: "convai",
    summary: "List the conversational agents configured on this deployment.",
    method: "GET",
    endpoint: "/v1/convai/agents",
    params: [],
    response: { kind: "json", description: "The available convai agents." },
    notes: [
      "Holding a conversation is a websocket surface (/v1/convai/conversation), not an HTTP tool — this lists what could be talked to.",
    ],
  },
] as const;

/** The capabilities a key holding `scopes` actually has. Everything else is
 *  ABSENT — not disabled, not listed with a flag. The key's scopes become the
 *  agent's real boundary only if the toolbox stops at them. */
export function capabilitiesFor(scopes: readonly string[]): Capability[] {
  const held = new Set(scopes);
  return CAPABILITIES.filter((c) => held.has(c.scope));
}

/** The granted scopes that carry no tool (none today, but a scope added to
 *  `service/keys.py` before it gains a capability would land here rather than
 *  disappearing silently). */
export function scopesWithoutCapabilities(scopes: readonly string[]): string[] {
  const covered = new Set(CAPABILITIES.map((c) => c.scope));
  return scopes.filter((s) => !covered.has(s));
}

// ── manifest ────────────────────────────────────────────────────────────────

/** Per-capability proof state.
 *
 *  `unknown` is the honest default and the ONLY thing a server can say: a
 *  PROVING attestation is this browser's memory of a sweep it ran (see
 *  attestation.ts — it lives in localStorage on purpose), so the route cannot
 *  read it and will not accept a caller's claim about it either. The studio
 *  folds its own proof in client-side with `foldProof` before it renders or
 *  copies a manifest. */
export type Proven = "true" | "false" | "unknown";

export type ManifestTool = Capability & { proven: Proven };

export type KeyManifest = {
  /** Bumped when the SHAPE changes, so a bridge can refuse a manifest it cannot read. */
  manifest_version: 1;
  generated_at: string;
  base_url: string;
  auth: { header: string; alternate: string; note: string };
  key: { id: string; name: string; prefix: string; scopes: string[]; revoked: boolean };
  tools: ManifestTool[];
  /** Stated, not implied: why the toolbox is the size it is. */
  boundary: string;
  proof: { source: string; note: string };
  /** Granted scopes with no tool behind them yet. Usually empty. */
  uncovered_scopes: string[];
};

/** Fold a PROVING attestation into a manifest, client-side, where the proof
 *  actually exists. `proven` becomes:
 *
 *    "true"    — a probe watched this deployment serve this scope for this key
 *    "false"   — the scope is granted on paper and a probe was REFUSED
 *    "unknown" — no usable proof (none taken, retired as stale, or taken on an
 *                open deployment where serving proves nothing about privilege)
 *
 *  An agent that reads "false" must not plan around the tool; an agent that
 *  reads "unknown" is being told nobody has checked, which is not the same
 *  thing and is never dressed up as one. */
export function foldProof(
  manifest: KeyManifest,
  proof: { proven: string[]; grantedButRefused: string[]; posture: string; stale?: boolean; checkedAt: string } | null,
): KeyManifest {
  if (!proof || proof.stale === true || proof.posture !== "enforced") return manifest;
  const proven = new Set(proof.proven);
  const refused = new Set(proof.grantedButRefused);
  return {
    ...manifest,
    tools: manifest.tools.map((t) => ({
      ...t,
      proven: proven.has(t.scope) ? "true" : refused.has(t.scope) ? "false" : "unknown",
    })),
    proof: {
      source: "studio attestation (this browser)",
      note: `Probed ${proof.checkedAt} against an enforcing deployment. A proof is a statement about the deployment at that moment — it retires when the posture changes.`,
    },
  };
}
