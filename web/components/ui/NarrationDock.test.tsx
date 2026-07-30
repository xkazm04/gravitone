import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

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
