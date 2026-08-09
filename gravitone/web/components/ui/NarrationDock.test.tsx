import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { NARRATABLE, clipKey, narrationPlan } from "@/lib/narratable";
import NarrationDock, {
  AUTO_NARRATOR, INITIAL_DOCK, pickNarrator, reduceDock,
  type DockEvent, type DockState,
} from "./NarrationDock";

// The transport's interesting bugs are all TRANSITION bugs, so the reducer is
// tested directly. The mounted tests then pin the two promises this feature
// makes out loud: nothing ever plays without a click, and every refusal is
// NAMED on screen rather than left as a dead button.

const run = (events: DockEvent[], from: DockState = INITIAL_DOCK) =>
  events.reduce(reduceDock, from);

describe("reduceDock", () => {
  it("starts collapsed, idle, at the top", () => {
    expect(INITIAL_DOCK).toEqual({ open: false, phase: "idle", index: 0, error: null });
  });

  it("ARMS without ever playing — the whole ?narrate=1 contract", () => {
    const s = run([{ t: "arm" }]);
    expect(s.open).toBe(true);
    expect(s.phase).toBe("idle");
  });

  it("collapsing does NOT stop the voice mid-sentence", () => {
    const s = run([{ t: "play" }, { t: "started" }, { t: "collapse" }]);
    expect(s.open).toBe(false);
    expect(s.phase).toBe("playing");
  });

  it("stop resets to the top and clears the error", () => {
    const s = run([{ t: "play" }, { t: "fail", message: "boom" }, { t: "stop" }]);
    expect(s).toMatchObject({ phase: "idle", index: 0, error: null });
  });

  it("keeps its place on failure, so play retries THAT sentence", () => {
    const s = run([{ t: "jump", index: 4 }, { t: "fail", message: "engine busy" }]);
    expect(s).toMatchObject({ phase: "error", index: 4, error: "engine busy" });
    expect(reduceDock(s, { t: "play" })).toMatchObject({ phase: "loading", index: 4, error: null });
  });

  it("advances one sentence at a time and finishes back at the top", () => {
    expect(run([{ t: "play" }, { t: "started" }, { t: "ended", total: 3 }]))
      .toMatchObject({ phase: "loading", index: 1 });
    expect(run([{ t: "jump", index: 2 }, { t: "ended", total: 3 }]))
      .toMatchObject({ phase: "idle", index: 0 });
  });

  it("skipping past the end ends the reading rather than loading nothing", () => {
    expect(run([{ t: "jump", index: 2 }, { t: "next", total: 3 }]))
      .toMatchObject({ phase: "idle", index: 0 });
  });

  it("never seeks before the first sentence", () => {
    expect(run([{ t: "prev" }, { t: "prev" }]).index).toBe(0);
  });

  it("pauses only from a live phase, and resumes only from paused", () => {
    expect(reduceDock(INITIAL_DOCK, { t: "pause" }).phase).toBe("idle");
    const playing = run([{ t: "play" }, { t: "started" }]);
    expect(reduceDock(playing, { t: "pause" }).phase).toBe("paused");
    expect(reduceDock(reduceDock(playing, { t: "pause" }), { t: "resume" }).phase).toBe("playing");
  });

  it("ignores a late 'started' from a clip that was already stopped", () => {
    const stopped = run([{ t: "play" }, { t: "started" }, { t: "stop" }]);
    expect(reduceDock(stopped, { t: "started" }).phase).toBe("idle");
  });
});

describe("pickNarrator", () => {
  const roster = [
    { character_id: "narr", name: "Marius", category: "premade" as const, tags: ["narration"] },
    { character_id: "warm", name: "Alba", category: "premade" as const, tags: ["warm"] },
    { character_id: "mine", name: "Mine", category: "cloned" as const, tags: [] },
  ];

  it("refuses to invent an id when the deployment has no Characters", () => {
    expect(pickNarrator([], AUTO_NARRATOR, "warm")).toBeNull();
  });

  it("honours an explicit choice for every section", () => {
    expect(pickNarrator(roster, "mine", "warm")?.character_id).toBe("mine");
    expect(pickNarrator(roster, "mine", "measured")?.character_id).toBe("mine");
  });

  it("falls back to the role hint when the chosen narrator is gone", () => {
    expect(pickNarrator(roster, "deleted", "measured")?.character_id).toBe("narr");
  });

  it("matches the hint against the roster's own tags", () => {
    expect(pickNarrator(roster, AUTO_NARRATOR, "warm")?.character_id).toBe("warm");
    expect(pickNarrator(roster, AUTO_NARRATOR, "measured")?.character_id).toBe("narr");
  });

  it("prefers a built-in over a clone when nothing matches the hint", () => {
    const plain = [
      { character_id: "c", name: "C", category: "cloned" as const, tags: [] },
      { character_id: "p", name: "P", category: "premade" as const, tags: [] },
    ];
    expect(pickNarrator(plain, AUTO_NARRATOR, "warm")?.character_id).toBe("p");
  });
});

// ── the mounted dock ─────────────────────────────────────────────────────────

let mockPath = "/";
vi.mock("next/navigation", () => ({ usePathname: () => mockPath }));

const ALBA = { character_id: "alba", name: "Alba", category: "premade", tags: ["warm"] };

/** Serve /api/characters; any OTHER request is a failure of the opt-in rule. */
function serveRoster(list: unknown, status = 200) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(typeof input === "object" && "url" in input ? input.url : input);
    if (url.includes("/api/characters")) {
      return new Response(JSON.stringify(list), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    }
    throw new Error(`unexpected request to ${url} — nothing may be synthesized unasked`);
  });
}

const pill = () => screen.getByRole("button", { name: /listen to this page/i });
const openDock = () => fireEvent.click(pill());

beforeEach(() => {
  mockPath = "/";
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() => Promise.resolve());
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("<NarrationDock />", () => {
  it("renders nothing at all on a route the registry cannot narrate", () => {
    mockPath = "/playground";
    const { container } = render(<NarrationDock />);
    expect(container).toBeEmptyDOMElement();
  });

  // The dock mounts app-wide from app/layout.tsx and self-nulls off the
  // registry. The embed is the surface where an unexpected voice would be
  // worst: it is a card a stranger frames on their own site, and the visitor
  // never asked this deployment for anything. Silence there is a promise.
  it("renders NOTHING on the embed surface — not even a pill", () => {
    mockPath = "/t/tk_abc123/embed";
    const fetchSpy = serveRoster([ALBA]);
    const { container } = render(<NarrationDock />);
    expect(container).toBeEmptyDOMElement();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("renders on /benchmarks too — both registry routes are wired", () => {
    mockPath = "/benchmarks";
    serveRoster([ALBA]);
    render(<NarrationDock />);
    expect(pill()).toBeInTheDocument();
  });

  it("mounts collapsed and makes NO request until it is opened", () => {
    const fetchSpy = serveRoster([ALBA]);
    render(<NarrationDock />);
    expect(pill()).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("expands, loads narrators, and still does not play a single byte", async () => {
    serveRoster([ALBA]);
    render(<NarrationDock />);
    openDock();
    await screen.findByRole("option", { name: "Alba" });
    expect(screen.getByRole("button", { name: /play the narration/i })).toBeEnabled();
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
  });

  it("NAMES a deployment with no Characters instead of leaving a dead button", async () => {
    serveRoster([]);
    render(<NarrationDock />);
    openDock();
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(/no Characters to read with/i));
    expect(screen.getByRole("button", { name: /play the narration/i })).toBeDisabled();
  });

  it("NAMES an unreachable backend rather than showing a silent spinner", async () => {
    serveRoster({ detail: "backend unreachable" }, 503);
    render(<NarrationDock />);
    openDock();
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(/backend unreachable/i));
  });

  it("shows the section and the exact sentence it is about to read", async () => {
    serveRoster([ALBA]);
    render(<NarrationDock />);
    openDock();
    expect(screen.getByText("Opening")).toBeInTheDocument();
    expect(screen.getByText(/CPU-native voice AI/i)).toBeInTheDocument();
    await screen.findByRole("option", { name: "Alba" });
  });

  it("is operable from the keyboard: Escape collapses the transport", async () => {
    serveRoster([ALBA]);
    render(<NarrationDock />);
    openDock();
    const panel = screen.getByRole("region", { name: /listen to this page/i });
    fireEvent.keyDown(panel, { key: "Escape" });
    await waitFor(() => expect(pill()).toBeInTheDocument());
  });

  // The <audio> element is shared by every sentence, and it fires `error` for
  // reasons that have nothing to do with the reading — a src cleared on stop,
  // a decode that lost its race with a new clip. The dock only reports one
  // while it is actually trying to play something; this pins BOTH halves of
  // that guard, including the idle→loading edge it implies.
  it("ignores an audio error while idle, and names one once a clip is cueing", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(typeof input === "object" && "url" in input ? input.url : input);
      if (url.includes("/api/characters")) {
        return new Response(JSON.stringify([ALBA]), {
          status: 200, headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/narration/manifest.json")) return new Response("", { status: 404 });
      // /api/speak never answers: the dock stays in `loading`, which is the
      // window this test is about.
      return new Promise<Response>(() => {});
    });
    const { container } = render(<NarrationDock />);
    openDock();
    await screen.findByRole("option", { name: "Alba" });
    const audio = container.querySelector("audio") as HTMLAudioElement;

    fireEvent.error(audio);
    expect(screen.getByRole("status")).not.toHaveTextContent(/would not play/i);
    expect(screen.getByRole("button", { name: /play the narration/i })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: /play the narration/i }));
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(/cueing this sentence/i));
    // The wait itself is announced — a live render can take seconds and the
    // glyph alone says nothing to a screen reader.
    expect(screen.getByRole("button", { name: /play the narration/i }))
      .toHaveAttribute("aria-busy", "true");

    fireEvent.error(audio);
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(/would not play in this browser/i));
  });

  it("remembers the chosen narrator across mounts", async () => {
    serveRoster([ALBA, { character_id: "marius", name: "Marius", category: "premade" }]);
    const first = render(<NarrationDock />);
    openDock();
    const select = await screen.findByRole("combobox");
    fireEvent.change(select, { target: { value: "marius" } });
    expect(localStorage.getItem("gravitone.narrator")).toBe("marius");
    first.unmount();

    render(<NarrationDock />);
    openDock();
    await waitFor(() =>
      expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("marius"));
  });
});

// ── the build-time bake ──────────────────────────────────────────────────────
//
// A baked clip must be preferred over synthesis and must be the SAME audio.
// The test asserts the second half of that by construction: the key the dock
// asks for is `clipKey`, computed here from the same registry the bake walks.

// jsdom has no object-URL support, and the existing suite never needed it
// (nothing in it ever reaches playback). These tests do.
function stubObjectUrls() {
  const url = URL as unknown as Record<string, unknown>;
  beforeEach(() => {
    url.createObjectURL = vi.fn(() => "blob:narration");
    url.revokeObjectURL = vi.fn();
  });
  // Deliberately NOT torn down: React's unmount cleanup revokes the object URL
  // during Testing Library's own afterEach, which runs after this one — a
  // delete here would make every play test fail in teardown.
}

function wav(): Blob {
  return new Blob([new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0])], { type: "audio/wav" });
}

/** Serve the roster, a manifest, baked clips and /api/speak — recording which
 *  of them was actually used. */
function serveBaked(clips: Record<string, number>) {
  const seen: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(typeof input === "object" && "url" in input ? input.url : input);
    seen.push(url);
    if (url.includes("/api/characters")) {
      return new Response(JSON.stringify([ALBA]), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("/narration/manifest.json")) {
      return new Response(JSON.stringify({
        version: 1, character_id: "alba", character_name: "Alba",
        generated: "2026-07-30T00:00:00Z", clips,
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (/\/narration\/[0-9a-f]{16}\.wav$/.test(url)) return new Response(wav(), { status: 200 });
    if (url.includes("/api/speak")) return new Response(wav(), { status: 200 });
    throw new Error(`unexpected request to ${url}`);
  });
  return seen;
}

const firstKey = () => {
  const step = narrationPlan(NARRATABLE["/"])[0];
  return clipKey("alba", step.block, step.sentence);
};

describe("<NarrationDock /> and the baked bundle", () => {
  stubObjectUrls();

  it("says a baked page costs no engine, before anything is played", async () => {
    serveBaked({ [firstKey()]: 4096 });
    render(<NarrationDock />);
    openDock();
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(/baked with Alba/i));
  });

  it("plays the BAKED file instead of calling the synthesis relay", async () => {
    const key = firstKey();
    const seen = serveBaked({ [key]: 4096 });
    render(<NarrationDock />);
    openDock();
    await screen.findByRole("option", { name: "Alba" });
    fireEvent.click(screen.getByRole("button", { name: /play the narration/i }));
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(/baked at build time/i));
    expect(seen.some((u) => u.endsWith(`/narration/${key}.wav`))).toBe(true);
    expect(seen.some((u) => u.includes("/api/speak"))).toBe(false);
  });

  it("falls through to live synthesis for a sentence that was never baked", async () => {
    const seen = serveBaked({ ffffffffffffffff: 1 });
    render(<NarrationDock />);
    openDock();
    await screen.findByRole("option", { name: "Alba" });
    fireEvent.click(screen.getByRole("button", { name: /play the narration/i }));
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(/rendered just now/i));
    expect(seen.some((u) => u.includes("/api/speak"))).toBe(true);
  });

  it("a deployment with no bake is the ordinary case, not an error", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(typeof input === "object" && "url" in input ? input.url : input);
      if (url.includes("/api/characters")) {
        return new Response(JSON.stringify([ALBA]), {
          status: 200, headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/narration/manifest.json")) return new Response("", { status: 404 });
      throw new Error(`unexpected request to ${url}`);
    });
    render(<NarrationDock />);
    openDock();
    await screen.findByRole("option", { name: "Alba" });
    expect(screen.getByRole("status")).not.toHaveTextContent(/baked/i);
    expect(screen.getByRole("status")).not.toHaveTextContent(/error|failed/i);
  });
});

// ── ?narration=<id>: the /v1/narrate consumer ────────────────────────────────

function setSearch(query: string) {
  window.history.replaceState({}, "", `/${query}`);
}

const PLAN = {
  narration_id: "n1a2b3c4",
  title: "Someone else's docs",
  blocks: [{
    id: "b000", label: "Intro", text: "This page came from the narrate endpoint.",
    emotion: "calm", character_hint: "measured", role: "lead",
  }],
};

function serveNarration(responder: (url: string) => Response) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(typeof input === "object" && "url" in input ? input.url : input);
    if (url.includes("/api/characters")) {
      return new Response(JSON.stringify([ALBA]), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("/narration/manifest.json")) return new Response("", { status: 404 });
    return responder(url);
  });
}

describe("<NarrationDock /> playing an arbitrary narration id", () => {
  stubObjectUrls();
  afterEach(() => setSearch(""));

  it("plays a plan fetched by id, on a route the registry does not cover", async () => {
    mockPath = "/playground"; // no registry entry at all
    setSearch("?narration=n1a2b3c4");
    serveNarration((url) => url.includes("/api/narrate/n1a2b3c4")
      ? new Response(JSON.stringify(PLAN), {
          status: 200, headers: { "Content-Type": "application/json" } })
      : new Response("", { status: 404 }));
    render(<NarrationDock />);
    await waitFor(() => expect(pill()).toBeInTheDocument());
    openDock();
    expect(await screen.findByText("Someone else's docs")).toBeInTheDocument();
    expect(screen.getByText(/came from the narrate endpoint/i)).toBeInTheDocument();
  });

  it("NAMES a plan that has aged out rather than falling silently back", async () => {
    setSearch("?narration=n1a2b3c4");
    serveNarration(() => new Response(
      JSON.stringify({ detail: "narration not found - plans are evicted oldest-first" }),
      { status: 404, headers: { "Content-Type": "application/json" } }));
    render(<NarrationDock />);
    await waitFor(() => expect(pill()).toBeInTheDocument());
    openDock();
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(/evicted oldest-first/i));
  });

  it("refuses an id that is not an id without making a request", async () => {
    setSearch("?narration=../../etc/passwd");
    const spy = serveNarration(() => new Response("", { status: 500 }));
    render(<NarrationDock />);
    await waitFor(() => expect(pill()).toBeInTheDocument());
    openDock();
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(/not a valid id/i));
    expect(spy.mock.calls.every(([i]) =>
      !String(i).includes("/api/narrate"))).toBe(true);
  });

  it("still does not play anything on its own", async () => {
    setSearch("?narration=n1a2b3c4");
    serveNarration(() => new Response(JSON.stringify(PLAN), {
      status: 200, headers: { "Content-Type": "application/json" } }));
    render(<NarrationDock />);
    await waitFor(() => expect(pill()).toBeInTheDocument());
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
  });
});
