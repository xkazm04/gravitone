// The Proving Ledger's pure core: WHICH request proves a scope, and what a
// given status MEANS. No fetching, no React, no "use client" — the server probe
// route, the ledger UI and the headless twin (scripts/prove-keys.mjs) all read
// their truth from here, so a probe can never mean two different things in two
// places.
//
// ── why a probe is shaped the way it is ──────────────────────────────────────
// A probe answers exactly ONE question: did the deployment ADMIT this request
// at the auth boundary? It deliberately does not ask whether the work would
// have succeeded. That is why most probes are cheap reads or deliberately
// malformed writes: `service/auth.py`'s dependency runs before FastAPI
// validates a body, so a 422 (or a 404 for a name that does not exist) proves
// admission just as well as a 200 — and costs the synth box nothing.
//
// Every probe here must therefore be SIDE-EFFECT-FREE. The single exception is
// the `tts` probe, which is a real one-word synthesis (per the design contract)
// because the tts scope's whole meaning is "may spend a synth slot"; it is
// bounded to one word and one probe per sweep.

/** Scope-level result. `unreachable` is a fourth observed value the design's
 *  E2 shape names, so the verdict union carries it too — a probe that never
 *  reached a box must not be filed as a refusal. */
export type ProbeObserved = "allowed" | "refused" | "unreachable";
export type ProbeExpected = "allowed" | "refused";
export type ProbeVerdict =
  | "proven"                 // granted, and served
  | "correctly-refused"      // not granted, and refused
  | "granted-but-refused"    // granted on paper, refused in fact
  | "REFUSED-SCOPE-SERVED"   // NOT granted, and served anyway — a vulnerability
  | "unreachable";

export type ProbeResult = {
  scope: string;
  expected: ProbeExpected;
  observed: ProbeObserved;
  verdict: ProbeVerdict;
  /** HTTP status the deployment answered with, or null when nothing answered. */
  status: number | null;
  /** The request that was made, so the row can say what it actually proved. */
  request: string;
};

/** What the studio can HONESTLY say about whether this backend checks keys —
 *  measured, not guessed, by an UNAUTHENTICATED request from a server route.
 *
 *  - `enforced`    — the bare request was refused (401/403). Only a configured
 *                    `TTS_API_KEY` does that; open mode never rejects anyone.
 *  - `open`        — the bare request was SERVED. The deployment answers every
 *                    unauthenticated caller and the keys on this page enforce
 *                    nothing. This is the loudest thing the page can say.
 *  - `unreachable` — nothing answered; there is no deployment to describe.
 *  - `unmeasured`  — no probe has run yet in this session. Not a posture; the
 *                    absence of one. Never rendered as reassurance. */
export type Posture = "enforced" | "open" | "unreachable" | "unmeasured";

/** The one unauthenticated read that separates a keyed backend from an open
 *  one. GET /v1/voices sits behind `require_read_write("tts", "voices")`, so a
 *  caller with no credential at all must be refused when enforcement is on. */
export const POSTURE_PROBE = { method: "GET", path: "/v1/voices" } as const;

export type ProbeSpec = {
  scope: string;
  method: string;
  /** `{voice}` is substituted with the probe voice id. */
  path: string;
  /** JSON body, or null for a bodyless request. */
  body: unknown | null;
  /** One line: what this request is and why it is safe to send. */
  why: string;
  /** True only for the tts probe — the one probe that spends real compute. */
  synthesizes?: boolean;
};

/** One probe per grantable scope in `service/keys.py::SCOPES`. Kept in the same
 *  order so a reader can diff the two lists by eye.
 *
 *  Paths are matched to the dependency that actually guards them in
 *  `service/app.py`, NOT to the endpoint a human would associate with the scope
 *  name — GET /v1/voices, for instance, needs `tts` (the read half of
 *  require_read_write), so it cannot prove the `voices` scope. The `voices`
 *  probe is a PATCH, the write half, aimed at a name no voice will ever have. */
export const PROBE_PLAN: readonly ProbeSpec[] = [
  {
    scope: "tts",
    method: "POST",
    path: "/v1/text-to-speech/{voice}?output_format=wav_24000",
    body: { text: "one" },
    why: "one-word synthesis — the only probe that spends a synth slot",
    synthesizes: true,
  },
  {
    scope: "voices",
    method: "PATCH",
    path: "/v1/voices/gravitone-probe-no-such-voice",
    body: {},
    why: "metadata write against a voice id that does not exist (404s harmlessly)",
  },
  {
    scope: "clone",
    method: "GET",
    path: "/v1/ingest/modes",
    body: null,
    why: "read on the clone-scoped ingest router — creates nothing",
  },
  {
    scope: "performance",
    method: "POST",
    path: "/v1/performance",
    body: {},
    why: "deliberately empty body — auth answers before validation does",
  },
  {
    scope: "stt",
    method: "POST",
    path: "/v1/speech-to-text",
    body: {},
    why: "deliberately empty body — no audio is uploaded or transcribed",
  },
  {
    scope: "convai",
    method: "GET",
    path: "/v1/convai/agents",
    body: null,
    why: "agent list read — holds no conversation",
  },
] as const;

/** Hard ceiling on a single sweep: the posture probe plus one per scope. A
 *  caller cannot ask this route to hammer a CPU-bound box by listing a scope
 *  twenty times. */
export const MAX_PROBES = PROBE_PLAN.length + 1;

export const DEFAULT_PROBE_VOICE = "alba";

export function probePath(spec: ProbeSpec, voice: string = DEFAULT_PROBE_VOICE): string {
  return spec.path.replace("{voice}", encodeURIComponent(voice));
}

/** 401 and 403 are the ONLY refusals. Everything else — 200, 404, 422, even a
 *  500 — means the request got past the auth boundary, which is the single
 *  thing a probe measures. */
export function observedFrom(status: number | null): ProbeObserved {
  if (status === null) return "unreachable";
  return status === 401 || status === 403 ? "refused" : "allowed";
}

export function verdictFor(expected: ProbeExpected, observed: ProbeObserved): ProbeVerdict {
  if (observed === "unreachable") return "unreachable";
  if (expected === "allowed") return observed === "allowed" ? "proven" : "granted-but-refused";
  return observed === "allowed" ? "REFUSED-SCOPE-SERVED" : "correctly-refused";
}

export function postureFrom(status: number | null): Posture {
  if (status === null) return "unreachable";
  return status === 401 || status === 403 ? "enforced" : "open";
}

/** A refusal only proves SCOPING if this deployment is known to recognise the
 *  secret at all — and `service/auth.py` answers 401 for "no key" and "valid
 *  key, wrong scope" alike (identical status, identical detail). So a sweep's
 *  negative probes are conclusive only when at least one POSITIVE probe was
 *  served: that is what distinguishes "the scope boundary held" from "this key
 *  is not recognised anywhere". Reported, never assumed. */
export function negativesAreConclusive(probes: readonly ProbeResult[]): boolean {
  return probes.some((p) => p.expected === "allowed" && p.verdict === "proven");
}

export type Sweep = {
  posture: Posture;
  /** ISO timestamp of the probe run — every proven chip carries it, because an
   *  attestation goes stale the moment TTS_API_KEY changes on the box. */
  checkedAt: string;
  probes: ProbeResult[];
  negativesConclusive: boolean;
};

/** The rows that are an ALERT rather than a result. */
export function servedScopesThatShouldNotBe(probes: readonly ProbeResult[]): ProbeResult[] {
  return probes.filter((p) => p.verdict === "REFUSED-SCOPE-SERVED");
}
