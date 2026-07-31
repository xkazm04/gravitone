// The proving route: the only place in the studio that talks to the backend
// WITHOUT the root key.
//
// Every other route goes through `backendFetch`, which attaches
// GRAVITONE_API_KEY — which is exactly why the keys page could never say
// anything about enforcement: a keyed backend and a wide-open one look
// identical through a proxy that always presents a valid credential. Here each
// request is sent `bare: true`, and the sweep presents ONLY the key under test.
// The browser cannot make these calls itself (CORS is default-closed), so this
// server route is the measurement instrument.
//
// GET  — posture only. One unauthenticated read. No secret involved.
// POST — posture plus the scope sweep for a secret the caller holds right now
//        (the mint/rotate moment). Probes are capped by PROBE_PLAN, run
//        strictly one at a time, and the secret is never logged.

import { backendFetch, jsonError } from "@/lib/backend";
import {
  MAX_PROBES,
  POSTURE_PROBE,
  PROBE_PLAN,
  DEFAULT_PROBE_VOICE,
  negativesAreConclusive,
  observedFrom,
  postureFrom,
  probePath,
  verdictFor,
  type ProbeResult,
  type Sweep,
} from "@/app/keys/_variants/probes";

const PROBE_TIMEOUT_MS = 15_000;
// The one-word synth probe waits on a real synth slot, which may be queued
// behind other work on a busy box.
const SYNTH_PROBE_TIMEOUT_MS = 60_000;

/** Send one probe and return only its status. The body is drained and thrown
 *  away — a probe reads a verdict off the status line, and an undrained synth
 *  response would hold a socket open for nothing. `null` means nothing
 *  answered, which is a posture in its own right and never a refusal. */
async function probeStatus(
  path: string,
  init: { method: string; body: unknown | null; secret?: string; timeoutMs: number },
): Promise<number | null> {
  const headers = new Headers();
  if (init.secret) headers.set("xi-api-key", init.secret);
  if (init.body !== null) headers.set("Content-Type", "application/json");
  try {
    const r = await backendFetch(path, {
      bare: true, // NEVER the studio's root key: it would prove the root key works
      method: init.method,
      headers,
      body: init.body === null ? undefined : JSON.stringify(init.body),
      cache: "no-store",
      signal: AbortSignal.timeout(init.timeoutMs),
    });
    try {
      await r.arrayBuffer();
    } catch {
      /* a body we could not drain changes no verdict */
    }
    return r.status;
  } catch {
    return null;
  }
}

async function measurePosture(): Promise<number | null> {
  return probeStatus(POSTURE_PROBE.path, {
    method: POSTURE_PROBE.method,
    body: null,
    timeoutMs: PROBE_TIMEOUT_MS,
  });
}

export async function GET(): Promise<Response> {
  const status = await measurePosture();
  const body: Sweep = {
    posture: postureFrom(status),
    checkedAt: new Date().toISOString(),
    probes: [],
    negativesConclusive: false,
  };
  return Response.json(body);
}

export async function POST(req: Request): Promise<Response> {
  let payload: { secret?: unknown; granted?: unknown; voice?: unknown };
  try {
    payload = (await req.json()) as typeof payload;
  } catch {
    return jsonError("probe body must be JSON", 400);
  }
  const secret = typeof payload.secret === "string" ? payload.secret : "";
  if (!secret) return jsonError("probe requires the secret to prove", 400);
  // The granted list is intersected with the plan rather than trusted: it names
  // which probes are POSITIVE, and an unknown scope has no probe to run.
  const grantedRaw = Array.isArray(payload.granted) ? payload.granted : [];
  const granted = new Set(
    grantedRaw.filter((s): s is string => typeof s === "string"),
  );
  const voice = typeof payload.voice === "string" && payload.voice ? payload.voice : DEFAULT_PROBE_VOICE;

  const postureStatus = await measurePosture();
  const posture = postureFrom(postureStatus);
  const checkedAt = new Date().toISOString();

  // Nothing answered the bare read; six more doomed requests would only slow the
  // reveal down and would say nothing the posture has not already said.
  if (posture === "unreachable") {
    const body: Sweep = { posture, checkedAt, probes: [], negativesConclusive: false };
    return Response.json(body);
  }

  const probes: ProbeResult[] = [];
  // SERIALIZED on purpose. The tts probe is a real synthesis; firing the plan
  // in parallel would hand a CPU-bound box a burst every time a key is minted.
  for (const spec of PROBE_PLAN.slice(0, MAX_PROBES - 1)) {
    const expected = granted.has(spec.scope) ? "allowed" : "refused";
    const status = await probeStatus(probePath(spec, voice), {
      method: spec.method,
      body: spec.body,
      secret,
      timeoutMs: spec.synthesizes ? SYNTH_PROBE_TIMEOUT_MS : PROBE_TIMEOUT_MS,
    });
    const observed = observedFrom(status);
    probes.push({
      scope: spec.scope,
      expected,
      observed,
      verdict: verdictFor(expected, observed),
      status,
      request: `${spec.method} ${probePath(spec, voice)}`,
    });
  }

  const body: Sweep = {
    posture,
    checkedAt,
    probes,
    negativesConclusive: negativesAreConclusive(probes),
  };
  return Response.json(body);
}
