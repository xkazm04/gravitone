import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { Character } from "@/app/voices/_data/characters";
import { DEFAULT_EXPRESSION, TAKE_TIMING_VERSION, type Take } from "./shared";

// ── the harness ───────────────────────────────────────────────────────────────
// PlaygroundConsole is the studio's largest surface and had no render test at
// all. It needs four things that jsdom does not provide — a roster + health +
// recommendation over fetch, IndexedDB for the take log and the composer, an
// AudioContext for waveform decoding, and object URLs — so the stubs are built
// ONCE here and every test reuses them.
//
// The seams are module boundaries the console already has (its engine, its two
// stores) rather than anything added for testing: the assertions below are all
// about what the user sees.

const engineMocks = vi.hoisted(() => ({
  speak: vi.fn(),
  perform: vi.fn(),
  uploadTake: vi.fn(),
  // Waveform refinement decodes audio; returning null is the documented
  // "keep the synthetic bars" degrade, so no AudioContext is needed.
  refinePeaks: vi.fn(async () => null),
}));
const storeMocks = vi.hoisted(() => ({
  getRecentTakes: vi.fn(async () => [] as Take[]),
  putTake: vi.fn(async () => {}),
  deleteTake: vi.fn(async () => {}),
}));

// The character data layer's hooks pull in Firebase auth, which refuses to
// initialize without real keys (same stub as characters.test.ts).
vi.mock("@/lib/useAuth", () => ({ useAuth: () => ({ user: null }) }));
vi.mock("@/lib/voiceVault", () => ({ recordVoiceOwnership: async () => ({ saved: 0, failed: 0 }) }));

vi.mock("./engine", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./engine")>()),
  ...engineMocks,
}));
vi.mock("@/lib/takeStore", () => storeMocks);
vi.mock("@/lib/composerStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/composerStore")>()),
  loadComposer: vi.fn(async () => null),
  saveComposer: vi.fn(async () => {}),
}));

import PlaygroundConsole from "./PlaygroundConsole";

function char(id: string, name: string, extra: Partial<Character> = {}): Character {
  return {
    character_id: id, name, category: "cloned", tags: [], lang: "en",
    voices: [], emotions: ["baseline"], coverage: 1, total: 8, ...extra,
  };
}

function take(over: Partial<Take> = {}): Take {
  return {
    id: "take-restored-1", text: "Stored line.", characterId: "sarah", characterName: "Sarah",
    mode: "gravitone", peaks: [0.5, 0.5], seconds: 3, kb: 40, rtf: 0.25,
    synthSeconds: 12, queueSeconds: 0, ignoredSettings: [], segments: [],
    expr: DEFAULT_EXPRESSION, createdAt: 1, ...over,
  };
}

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json" },
  });
}

type Options = {
  characters?: Character[];
  /** The /health body. `null` = the studio cannot reach the backend at all. */
  health?: Record<string, unknown> | null;
  restored?: Take[];
};

/** The keyed-backend / unkeyed-studio answer: the engine is up and healthy and
 *  tells this caller NOTHING about its queue, because metrics live behind the
 *  observability scope (service/app.py::health). */
const HEALTH_NO_SCOPE = { status: "ready", workers_live: 2, workers_configured: 2 };
/** The same engine seen by a studio that does hold the key. */
const healthWithMetrics = (m: Record<string, number>) => ({ status: "ready", metrics: m });

function stubFetch(o: Options) {
  const characters = o.characters ?? [char("sarah", "Sarah")];
  const health = o.health === undefined ? healthWithMetrics({ queued: 0, in_flight: 0 }) : o.health;
  const f = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/api/characters")) return jsonRes(characters);
    if (url.includes("/api/reviews/preferred")) return jsonRes({ character_id: null, picks: 0 });
    if (url.includes("/api/health")) {
      if (health === null) throw new TypeError("network");
      return jsonRes(health);
    }
    return jsonRes({ detail: `unexpected request: ${url}` }, 500);
  });
  vi.stubGlobal("fetch", f);
  return f;
}

/** Render the console and wait until it is usable: the roster has landed AND a
 *  Character is selected (the rail's pressed state), which is what Generate is
 *  gated on. */
async function mountConsole(o: Options = {}) {
  storeMocks.getRecentTakes.mockResolvedValue(o.restored ?? []);
  stubFetch(o);
  const view = render(<PlaygroundConsole />);
  const first = (o.characters ?? [char("sarah", "Sarah")])[0];
  await screen.findByRole("button", { name: new RegExp(first.name), pressed: true });
  return view;
}

/** Press Generate with a synthesis call that never settles, so the console
 *  stays in its rendering state and the status row can be read. */
async function startRender() {
  engineMocks.speak.mockImplementation(() => new Promise<never>(() => {}));
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /Generate/ }));
  });
  return await screen.findByText("rendering");
}

/** The whole status paragraph under the render clock. */
function statusLine(): HTMLElement {
  const row = screen.getByText("rendering").closest("div.glass-panel");
  if (!row) throw new Error("render status row not found");
  return row as HTMLElement;
}

beforeEach(() => {
  vi.stubGlobal("URL", Object.assign(URL, {
    createObjectURL: vi.fn(() => "blob:take"),
    revokeObjectURL: vi.fn(),
  }));
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ── direction 1: "unavailable" must not look like "empty" ─────────────────────

describe("PlaygroundConsole — the queue reading says whether it is a reading", () => {
  it("reports the queue as UNAVAILABLE when a keyed backend answers an unkeyed studio", async () => {
    // The deployment that produces this: GRAVITONE_API_KEY unset in the studio,
    // set on the backend. /health answers {"status":"ready"} with no metrics —
    // and the console used to coerce that to 0, so "we cannot see the queue"
    // rendered exactly like "the queue is empty", with nothing marked stale
    // because the request succeeded.
    await mountConsole({ health: HEALTH_NO_SCOPE });
    await startRender();
    expect(statusLine()).toHaveTextContent(/queue depth unavailable to this studio/i);
    expect(statusLine()).not.toHaveTextContent(/queue clear/i);
    expect(statusLine()).not.toHaveTextContent(/queued ahead of the pool/i);
    expect(statusLine()).not.toHaveTextContent(/0 rendering/i);
  });

  it("states an empty queue as an actual reading", async () => {
    await mountConsole({ health: healthWithMetrics({ queued: 0, in_flight: 0 }) });
    await startRender();
    expect(statusLine()).toHaveTextContent(/queue clear/i);
    expect(statusLine()).not.toHaveTextContent(/unavailable/i);
  });

  it("still reports a queue it can see", async () => {
    await mountConsole({ health: healthWithMetrics({ queued: 3, in_flight: 1 }) });
    await startRender();
    expect(statusLine()).toHaveTextContent(/3 jobs queued ahead of the pool/i);
    expect(statusLine()).toHaveTextContent(/1 rendering/i);
    expect(statusLine()).not.toHaveTextContent(/unavailable/i);
    expect(statusLine()).not.toHaveTextContent(/queue clear/i);
  });
});

describe("PlaygroundConsole — the render estimate names its basis or its absence", () => {
  it("says the engine's realtime factor is invisible rather than 'no estimate yet'", async () => {
    // Both readings are missing for the SAME reason (no observability scope);
    // "the first render on this machine calibrates one" is a different untrue
    // statement, because the engine's own average does exist.
    await mountConsole({ health: HEALTH_NO_SCOPE });
    await startRender();
    expect(statusLine()).toHaveTextContent(/realtime factor is not visible to this studio/i);
  });

  it("says a first render is what calibrates one when the reading IS visible", async () => {
    await mountConsole({ health: healthWithMetrics({ queued: 0, in_flight: 0 }) });
    await startRender();
    expect(statusLine()).toHaveTextContent(/the first render on this machine is what calibrates one/i);
    expect(statusLine()).not.toHaveTextContent(/not visible to this studio/i);
  });

  it("estimates from the engine's live average when it can see one", async () => {
    await mountConsole({ health: healthWithMetrics({ queued: 0, in_flight: 0, realtime_factor: 0.4 }) });
    await startRender();
    expect(statusLine()).toHaveTextContent(/the engine is averaging 0.4× realtime/i);
  });

  it("prefers the user's own last render over the engine average", async () => {
    await mountConsole({
      health: healthWithMetrics({ queued: 0, in_flight: 0, realtime_factor: 0.4 }),
      restored: [take({ rtf: 0.25, timingVersion: TAKE_TIMING_VERSION })],
    });
    await startRender();
    expect(statusLine()).toHaveTextContent(/your last render ran at 0.25× realtime/i);
  });

  it("refuses to calibrate from a take stored before the timing fix", async () => {
    // A restored record with no timingVersion carries the summed per-segment
    // realtime factor, which overstates throughput and understates the wait.
    // It is still shown in the log; it just may not predict.
    await mountConsole({ health: HEALTH_NO_SCOPE, restored: [take({ rtf: 4, timingVersion: undefined })] });
    await startRender();
    expect(statusLine()).not.toHaveTextContent(/your last render ran at/i);
    expect(statusLine()).toHaveTextContent(/realtime factor is not visible to this studio/i);
    // …and the take itself is still in the log.
    expect(screen.getByText("Stored line.")).toBeInTheDocument();
  });
});
