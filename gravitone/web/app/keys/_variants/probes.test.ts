// The probe core is the one place where a status becomes a claim about
// security, so every cell of that mapping is pinned here — and the headless
// twin is asserted to be the SAME plan, because a CI gate and a browser panel
// that disagree about what "proven" means is worse than having neither.

import { describe, expect, it } from "vitest";

import {
  MAX_PROBES,
  PROBE_PLAN,
  POSTURE_PROBE,
  negativesAreConclusive,
  observedFrom,
  postureFrom,
  probePath,
  servedScopesThatShouldNotBe,
  verdictFor,
  type ProbeResult,
} from "./probes";
import * as twin from "../../../../scripts/prove-keys.mjs";

const result = (over: Partial<ProbeResult> = {}): ProbeResult => ({
  scope: "tts", expected: "allowed", observed: "allowed", verdict: "proven",
  status: 200, request: "GET /x", ...over,
});

describe("what a status means", () => {
  it("treats ONLY 401 and 403 as refusals", () => {
    expect(observedFrom(401)).toBe("refused");
    expect(observedFrom(403)).toBe("refused");
    // A 422 or a 404 means the request got PAST auth — which is the entire
    // question a probe asks. Reading them as failures would report a scope the
    // key really holds as refused.
    for (const s of [200, 204, 400, 404, 409, 422, 429, 500]) {
      expect(observedFrom(s)).toBe("allowed");
    }
  });

  it("never calls a silent box a refusal", () => {
    expect(observedFrom(null)).toBe("unreachable");
    expect(verdictFor("refused", "unreachable")).toBe("unreachable");
    expect(postureFrom(null)).toBe("unreachable");
  });

  it("reads posture from an unauthenticated request, both ways", () => {
    expect(postureFrom(401)).toBe("enforced");
    expect(postureFrom(200)).toBe("open");
    // A 404 to an unauthenticated caller still means it was not asked for a
    // key: the box is open.
    expect(postureFrom(404)).toBe("open");
  });
});

describe("the four verdicts", () => {
  it("maps every expected/observed pair exactly once", () => {
    expect(verdictFor("allowed", "allowed")).toBe("proven");
    expect(verdictFor("allowed", "refused")).toBe("granted-but-refused");
    expect(verdictFor("refused", "refused")).toBe("correctly-refused");
    expect(verdictFor("refused", "allowed")).toBe("REFUSED-SCOPE-SERVED");
  });

  it("names the ungranted-but-served rows as the alert they are", () => {
    const rows = [
      result(),
      result({ scope: "clone", expected: "refused", verdict: "REFUSED-SCOPE-SERVED" }),
    ];
    expect(servedScopesThatShouldNotBe(rows).map((r) => r.scope)).toEqual(["clone"]);
  });

  it("calls refusals inconclusive until a positive probe was served", () => {
    // service/auth.py answers 401 for "no key" and "wrong scope" alike, so a
    // sweep where NOTHING was served proves the key is unrecognised — not that
    // scoping works. Claiming the latter would be the whole feature lying.
    const allRefused = [
      result({ observed: "refused", verdict: "granted-but-refused" }),
      result({ scope: "clone", expected: "refused", observed: "refused", verdict: "correctly-refused" }),
    ];
    expect(negativesAreConclusive(allRefused)).toBe(false);
    expect(negativesAreConclusive([...allRefused, result()])).toBe(true);
  });
});

describe("the probe plan", () => {
  it("covers every grantable scope exactly once", () => {
    // service/keys.py::SCOPES — a scope with no probe can never be proven, and
    // would silently render as declared-only forever.
    expect(PROBE_PLAN.map((p) => p.scope)).toEqual(
      ["tts", "voices", "clone", "performance", "stt", "convai"],
    );
  });

  it("spends a synth slot on exactly one probe", () => {
    expect(PROBE_PLAN.filter((p) => p.synthesizes)).toHaveLength(1);
    expect(PROBE_PLAN.find((p) => p.synthesizes)?.scope).toBe("tts");
  });

  it("aims every write-shaped probe at something that cannot exist or cannot commit", () => {
    // A probe must never mutate a real deployment: the only PATCH targets a
    // voice id nothing will ever have, and the POSTs carry empty bodies that
    // die at validation, after auth has already answered.
    for (const p of PROBE_PLAN) {
      if (p.method === "GET") continue;
      const harmless =
        p.path.includes("no-such-voice") ||
        JSON.stringify(p.body) === "{}" ||
        p.synthesizes === true;
      expect(harmless, `${p.method} ${p.path} must be side-effect-free`).toBe(true);
    }
  });

  it("caps a sweep at the plan plus the posture probe", () => {
    expect(MAX_PROBES).toBe(PROBE_PLAN.length + 1);
  });

  it("substitutes and encodes the probe voice", () => {
    expect(probePath(PROBE_PLAN[0], "my voice/1")).toContain("my%20voice%2F1");
    expect(probePath(PROBE_PLAN[1], "ignored")).toBe(PROBE_PLAN[1].path);
  });
});

// ── the headless twin must be the same instrument ────────────────────────────
describe("scripts/prove-keys.mjs does not drift from the studio", () => {
  it("runs the identical probe plan", () => {
    expect(twin.PROBES.map((p: { scope: string }) => p.scope))
      .toEqual(PROBE_PLAN.map((p) => p.scope));
    for (const [i, spec] of PROBE_PLAN.entries()) {
      const other = twin.PROBES[i];
      expect(`${other.method} ${other.path}`).toBe(`${spec.method} ${spec.path}`);
      expect(JSON.stringify(other.body ?? null)).toBe(JSON.stringify(spec.body ?? null));
    }
    expect(twin.POSTURE_PROBE.path).toBe(POSTURE_PROBE.path);
    expect(twin.POSTURE_PROBE.method).toBe(POSTURE_PROBE.method);
  });

  it("draws the identical verdicts", () => {
    for (const status of [null, 200, 401, 403, 404, 422, 500]) {
      expect(twin.observedFrom(status)).toBe(observedFrom(status));
      expect(twin.postureFrom(status)).toBe(postureFrom(status));
    }
    for (const expected of ["allowed", "refused"] as const) {
      for (const observed of ["allowed", "refused", "unreachable"] as const) {
        expect(twin.verdictFor(expected, observed)).toBe(verdictFor(expected, observed));
      }
    }
  });

  it("fails a pipeline on the two findings that must never ship quietly", () => {
    const served = { verdict: "REFUSED-SCOPE-SERVED" };
    expect(twin.exitCodeFor({ posture: "enforced", probes: [served] })).toBe(1);
    expect(twin.exitCodeFor({ posture: "open", probes: [] })).toBe(1);
    expect(twin.exitCodeFor({ posture: "unreachable", probes: [] })).toBe(2);
    expect(twin.exitCodeFor({ posture: "enforced", probes: [{ verdict: "proven" }] })).toBe(0);
  });
});
