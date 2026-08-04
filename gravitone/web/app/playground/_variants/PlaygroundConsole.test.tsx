import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { Character } from "@/app/voices/_data/characters";
import { DEFAULT_EXPRESSION, TAKE_TIMING_VERSION, type Segment, type Take } from "./shared";
import type { SpeakResult } from "./engine";

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

const engineMocks = vi.hoisted(() => {
  const speak = vi.fn();
  return {
    speak,
    // The solo path calls speakStreaming, whose own policy is "stream when the
    // request qualifies, otherwise take the buffered call". The harness drives
    // ONE mock through both, so every existing solo test asserts what it always
    // asserted; the tests that are ABOUT streaming override this directly.
    speakStreaming: vi.fn((text: string, id: string, expr: unknown) => speak(text, id, expr)),
    perform: vi.fn(),
    uploadTake: vi.fn(),
    // Waveform refinement decodes audio; returning null is the documented
    // "keep the synthetic bars" degrade, so no AudioContext is needed.
    refinePeaks: vi.fn(async () => null),
  };
});
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

/** Press Generate with a synthesis call that resolves into a take. */
async function generateOnce(result: Partial<SpeakResult> = {}) {
  engineMocks.speak.mockResolvedValue({
    mode: "gravitone", url: "blob:new", blob: new Blob(["wav"]), peaks: [0.4, 0.9],
    seconds: 2.5, kb: 30, rtf: 0.3, synthSeconds: 8, queueSeconds: 0,
    // `synthSegments` and `format` became required on SpeakResult in the same
    // wave that added this harness (the proxy builder's mp3 + header work).
    // `satisfies` is what pointed here — keep it, so the next field addition
    // fails at this one fixture instead of somewhere downstream.
    synthSegments: 1, format: "wav_24000",
    ignoredSettings: [], segments: [], reportCorrupt: false, ...result,
  } satisfies SpeakResult);
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /Generate/ }));
  });
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

  it("replaces the estimate with MEASURED progress once audio is arriving", async () => {
    // The whole apology UI — the estimate, its basis, the past-the-estimate
    // state — exists because progress could not be observed. On the streaming
    // path it can be, and a guess shown in front of a measurement is a choice.
    await mountConsole({ health: healthWithMetrics({ queued: 0, in_flight: 0, realtime_factor: 0.4 }) });
    let report!: (seconds: number) => void;
    engineMocks.speakStreaming.mockImplementation(
      (_t: string, _c: string, _e: unknown,
       handlers: { onProgress?: (s: number) => void } = {}) => {
        report = handlers.onProgress ?? (() => {});
        return new Promise<never>(() => {});
      });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Generate/ }));
    });
    await screen.findByText("rendering");
    expect(statusLine()).toHaveTextContent(/the engine is averaging 0.4× realtime/i);

    await act(async () => { report(1.4); });
    expect(statusLine()).toHaveTextContent(/1\.4s of audio received and playing/i);
    expect(statusLine()).not.toHaveTextContent(/Estimated ~/);
  });
});

// ── direction 2: the console's own surfaces ───────────────────────────────────

describe("PlaygroundConsole — the fallback banner describes the LATEST take", () => {
  it("names the actual cause of a browser fallback", async () => {
    await mountConsole();
    await generateOnce({ mode: "browser", fallbackReason: "failed", fallbackDetail: "engine error (req-7)" });
    const banner = screen.getByText(/reachable but synthesis failed/i);
    expect(banner).toHaveTextContent(/Backend said: engine error \(req-7\)/);
  });

  it("drops the banner once a later take succeeds", async () => {
    // It used to scan the whole log for ANY browser take ever made, so one
    // fallback pinned the warning across every later successful render — and
    // across a session restore.
    await mountConsole();
    await generateOnce({ mode: "browser", fallbackReason: "unreachable" });
    expect(screen.getByText(/backend unreachable — speaking with your browser voice/i)).toBeInTheDocument();
    await generateOnce({ mode: "gravitone" });
    expect(screen.queryByText(/browser voice/i)).toBeNull();
  });
});

describe("PlaygroundConsole — a finished render is announced", () => {
  it("puts the completed take in a live region", async () => {
    // The render clock is aria-live="off" (it ticks 4x/s) and the take log is
    // not a live region, so a screen-reader user got no signal at all that the
    // thing they pressed Generate for had happened.
    await mountConsole();
    await generateOnce({ mode: "gravitone", seconds: 2.5 });
    expect(screen.getByRole("status")).toHaveTextContent(
      /Take ready — 2.5 seconds of audio from Sarah/i);
  });

  it("says when the take came from the browser voice instead", async () => {
    await mountConsole();
    await generateOnce({ mode: "browser", fallbackReason: "unreachable", seconds: 1.5 });
    expect(screen.getByRole("status")).toHaveTextContent(/Browser-voice take ready/i);
  });

  it("does not re-announce a spent message on the next run", async () => {
    await mountConsole();
    await generateOnce({ mode: "gravitone", seconds: 2.5 });
    engineMocks.speak.mockImplementation(() => new Promise<never>(() => {}));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Generate/ }));
    });
    expect(screen.getByRole("status")).toHaveTextContent("");
  });
});

describe("PlaygroundConsole — the character rail's filter and keyboard navigation", () => {
  const roster = [
    "Aria", "Bo", "Cleo", "Dee", "Eli", "Fin", "Gus", "Hana", "Ivo", "Jun", "Kit", "Lena",
  ].map((n) => char(n.toLowerCase(), n));

  /** Open the overflow panel, where the filter lives. */
  async function openRail() {
    await mountConsole({ characters: roster });
    fireEvent.click(screen.getByRole("button", { name: /\+2 more/ }));
    return screen.getByLabelText("Filter characters");
  }

  it("reaches a Character the collapsed rail cannot show", async () => {
    // Clone an eleventh voice and it used to be simply unreachable in Solo
    // mode, while Script mode's select listed every one of them.
    await mountConsole({ characters: roster });
    expect(screen.queryByRole("button", { name: /Lena/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /\+2 more/ }));
    expect(screen.getByRole("button", { name: /Lena/ })).toBeInTheDocument();
  });

  it("filters the rail and says when nothing matches", async () => {
    const filter = await openRail();
    fireEvent.change(filter, { target: { value: "na" } });
    expect(screen.getByRole("button", { name: /Hana/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Lena/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Aria/ })).toBeNull();
    fireEvent.change(filter, { target: { value: "zzz" } });
    expect(screen.getByText(/No Character matches/)).toBeInTheDocument();
  });

  it("moves focus between the Characters actually on screen after a filter", async () => {
    // The refs behind the roving tabindex are keyed by Character id rather than
    // by position in the filtered list. This pins the BEHAVIOUR — arrows land
    // on the buttons that are actually on screen — which is what must survive
    // whatever the refs are keyed on next.
    const filter = await openRail();
    fireEvent.change(filter, { target: { value: "na" } });
    const hana = screen.getByRole("button", { name: /Hana/ });
    const lena = screen.getByRole("button", { name: /Lena/ });
    hana.focus();
    fireEvent.keyDown(hana, { key: "ArrowRight" });
    expect(document.activeElement).toBe(lena);
    // …and it wraps, still within the visible set.
    fireEvent.keyDown(lena, { key: "ArrowRight" });
    expect(document.activeElement).toBe(hana);
    fireEvent.keyDown(hana, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(lena);
  });

  it("keeps arrow keys inside the visible set when the filter widens again", async () => {
    const filter = await openRail();
    fireEvent.change(filter, { target: { value: "na" } });
    fireEvent.change(filter, { target: { value: "" } });
    const aria = screen.getByRole("button", { name: /Aria/ });
    aria.focus();
    fireEvent.keyDown(aria, { key: "End" });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /Lena/ }));
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Home" });
    expect(document.activeElement).toBe(aria);
  });
});

describe("PlaygroundConsole — reuse loads a take back into the composer", () => {
  it("restores a solo take as solo", async () => {
    await mountConsole({ restored: [take({ text: "Reused solo line.", url: "blob:r" })] });
    fireEvent.click(screen.getByRole("button", { name: /reuse/ }));
    expect(screen.getByRole("button", { name: "solo" })).toHaveAttribute("aria-pressed", "true");
    expect((screen.getAllByRole("textbox")[0] as HTMLTextAreaElement).value).toBe("Reused solo line.");
  });

  it("restores a performance take as a script, line by line", async () => {
    await mountConsole({
      characters: [char("sarah", "Sarah"), char("bo", "Bo")],
      restored: [take({
        text: "Sarah: One.  ·  Bo: Two.", url: "blob:r",
        lines: [{ character_id: "sarah", text: "One." }, { character_id: "bo", text: "Two." }],
      })],
    });
    fireEvent.click(screen.getByRole("button", { name: /reuse/ }));
    expect(screen.getByRole("button", { name: "script" })).toHaveAttribute("aria-pressed", "true");
    const values = screen.getAllByRole("textbox").map((t) => (t as HTMLTextAreaElement).value);
    expect(values).toContain("One.");
    expect(values).toContain("Two.");
    // Each line keeps the Character that spoke it.
    expect((screen.getByLabelText("Character for line 1") as HTMLSelectElement).value).toBe("sarah");
    expect((screen.getByLabelText("Character for line 2") as HTMLSelectElement).value).toBe("bo");
  });
});

// ── direction 3: the take log became editable ────────────────────────────────

describe("PlaygroundConsole — punch-in is a drill-down, not a new card layout", () => {
  const seg = (text: string, seconds: number): Segment => ({
    text, requested: "baseline", used: "baseline", fallback: false,
    voice_id: "v1", seconds,
  });
  const editable = (over: Partial<Take> = {}) => [take({
    url: "blob:r", blob: new Blob(["wav"]), seconds: 2,
    segments: [seg("one", 1), seg("two", 1)], ...over,
  })];

  it("keeps the card uncluttered until the timeline is asked for", async () => {
    // The editor must not cost every take card its density: nothing about a take
    // row changes until the user opens it.
    await mountConsole({ restored: editable() });
    expect(screen.queryByRole("button", { name: /Segment 1 of 2/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /timeline/ }));
    expect(screen.getByRole("button", { name: /Segment 1 of 2/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Segment 2 of 2/ })).toBeInTheDocument();
    // …and it collapses again.
    fireEvent.click(screen.getByRole("button", { name: /timeline/ }));
    expect(screen.queryByRole("button", { name: /Segment 1 of 2/ })).toBeNull();
  });

  it("offers a retake of the clicked region, prefilled with what it says", async () => {
    await mountConsole({ restored: editable() });
    fireEvent.click(screen.getByRole("button", { name: /timeline/ }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Segment 2 of 2/ }));
    });
    const area = screen.getByLabelText("Text for segment 2") as HTMLTextAreaElement;
    expect(area.value).toBe("two");
    expect(screen.getByRole("button", { name: /render lane X/ })).toBeInTheDocument();
  });

  it("has no timeline to offer for a browser-fallback take", async () => {
    // Nothing was synthesized, so there is no audio to seek and nothing to
    // splice — the button says why instead of failing on the click.
    await mountConsole({ restored: [take({ mode: "browser", url: undefined, blob: undefined })] });
    expect(screen.getByRole("button", { name: /timeline/ })).toBeDisabled();
  });

  it("says a take is a splice, and names the take it came from", async () => {
    await mountConsole({
      restored: editable({
        id: "take-spliced", edits: { v: 1, source: "take-base-7", regions: [{ i: 1, text: "two again" }] },
      }),
    });
    expect(screen.getByText(/punched · segment 2 re-rendered and spliced/i)).toBeInTheDocument();
    expect(screen.getByText(/base take-base-7/)).toBeInTheDocument();
  });

  it("restores a take written before the editor existed, with no provenance claimed", async () => {
    // Takes are durable: the log reads records from builds that had no `edits`
    // field. They must restore, play and export exactly as they did.
    await mountConsole({ restored: editable({ text: "Older stored line." }) });
    expect(screen.getByText("Older stored line.")).toBeInTheDocument();
    expect(screen.queryByText(/punched ·/i)).toBeNull();
    expect(screen.getByRole("button", { name: /timeline/ })).toBeEnabled();
  });
});

describe("PlaygroundConsole — a failed publish is reported and cleans up after itself", () => {
  const shareable = () => [take({ url: "blob:r", blob: new Blob(["wav"]) })];

  it("says what the backend said and offers the button again", async () => {
    await mountConsole({ restored: shareable() });
    engineMocks.uploadTake.mockRejectedValue(new Error("take store full (req-9)"));
    vi.useFakeTimers();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "↗ share" }));
    });
    expect(screen.getByRole("button", { name: "✗ failed" })).toBeInTheDocument();
    expect(screen.getByText(/could not be published — take store full \(req-9\)/)).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(screen.getByRole("button", { name: "↗ share" })).toBeInTheDocument();
  });

  it("leaves no timer running for a console the user has navigated away from", async () => {
    // The self-clearing chip was a bare setTimeout with no cleanup and no
    // mounted guard — it kept a setState scheduled against a dead component,
    // the one async path in this file that did not check mounted.current.
    const { unmount } = await mountConsole({ restored: shareable() });
    engineMocks.uploadTake.mockRejectedValue(new Error("nope"));
    // Only setTimeout is faked: framer-motion's animation frames would otherwise
    // be counted as pending timers too. Installed AFTER mount, so the only
    // timeout in play is the chip's own.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "↗ share" }));
    });
    expect(screen.getByRole("button", { name: "✗ failed" })).toBeInTheDocument();
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
