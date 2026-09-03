import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

// ── the reading says who is reading it ───────────────────────────────────────
//
// On "auto" the narrator is matched per BLOCK from the section's characterHint,
// so one reading of a page can change voice partway through. That is deliberate
// authoring — these tests do not touch the policy. They pin the DISCLOSURE: the
// dock always states who is reading, and when that changes mid-reading it says
// so through the live region rather than leaving the listener to wonder whether
// something broke.

let mockPath = "/benchmarks";
vi.mock("next/navigation", () => ({ usePathname: () => mockPath }));

import { NARRATABLE, narrationPlan } from "@/lib/narratable";
import NarrationDock from "./NarrationDock";

const ALBA = { character_id: "alba", name: "Alba", category: "premade", tags: ["warm"] };
const MARIUS = { character_id: "marius", name: "Marius", category: "premade", tags: ["narration"] };

function wav(): Blob {
  return new Blob([new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0])], { type: "audio/wav" });
}

function serve(roster: unknown[]) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(typeof input === "object" && "url" in input ? input.url : input);
    if (url.includes("/api/characters")) {
      return new Response(JSON.stringify(roster), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("/narration/manifest.json")) return new Response("", { status: 404 });
    if (url.includes("/api/speak")) return new Response(wav(), { status: 200 });
    throw new Error(`unexpected request to ${url}`);
  });
}

const plan = narrationPlan(NARRATABLE["/benchmarks"]);
/** The first sentence whose section asks for a different sort of voice than the
 *  opening one — computed from the registry, never a hard-coded index. */
const SWITCH_AT = plan.findIndex((s) => s.block.characterHint !== plan[0].block.characterHint);

const status = () => screen.getByRole("status");
const openDock = () =>
  fireEvent.click(screen.getByRole("button", { name: /listen to this page/i }));

/** Play, then step forward to `target`, waiting for each sentence to be live. */
async function advanceTo(target: number) {
  fireEvent.click(screen.getByRole("button", { name: /play the narration/i }));
  await waitFor(() => expect(status()).toHaveTextContent(/rendered just now/i));
  for (let i = 0; i < target; i += 1) {
    fireEvent.click(screen.getByRole("button", { name: /next sentence/i }));
    await waitFor(() => expect(status()).toHaveTextContent(/rendered just now/i));
  }
}

beforeEach(() => {
  mockPath = "/benchmarks";
  localStorage.clear();
  (URL as unknown as Record<string, unknown>).createObjectURL = vi.fn(() => "blob:narration");
  (URL as unknown as Record<string, unknown>).revokeObjectURL = vi.fn();
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() => Promise.resolve());
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the dock names its reader", () => {
  it("has a section that changes voice — otherwise these tests prove nothing", () => {
    expect(SWITCH_AT).toBeGreaterThan(0);
  });

  it("states who is reading before a single byte is played", async () => {
    serve([ALBA, MARIUS]);
    render(<NarrationDock />);
    openDock();
    await screen.findByRole("option", { name: "Alba" });
    expect(await screen.findByText(/read by Alba/i)).toBeInTheDocument();
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
  });

  it("NAMES the handover when the section asks for a different voice", async () => {
    serve([ALBA, MARIUS]);
    render(<NarrationDock />);
    openDock();
    await screen.findByRole("option", { name: "Alba" });
    expect(await screen.findByText(/read by Alba/i)).toBeInTheDocument();

    await advanceTo(SWITCH_AT);
    expect(screen.getByText(/read by Marius/i)).toBeInTheDocument();
    await waitFor(() =>
      expect(status()).toHaveTextContent(/Marius reads this section, after Alba/i));

    // Said once, on the sentence it happened — not a label that sticks around
    // repeating itself for the rest of the reading.
    if (plan[SWITCH_AT + 1]?.block.characterHint === plan[SWITCH_AT].block.characterHint) {
      fireEvent.click(screen.getByRole("button", { name: /next sentence/i }));
      await waitFor(() => expect(status()).not.toHaveTextContent(/after Alba/i));
      expect(screen.getByText(/read by Marius/i)).toBeInTheDocument();
    }
  });

  it("says nothing about a handover on a deployment with ONE narrator", async () => {
    serve([ALBA]);
    render(<NarrationDock />);
    openDock();
    await screen.findByRole("option", { name: "Alba" });

    await advanceTo(SWITCH_AT);
    // Same voice across the section boundary: stating who reads, claiming no
    // change that did not happen.
    expect(screen.getByText(/read by Alba/i)).toBeInTheDocument();
    expect(status()).not.toHaveTextContent(/reads this section, after/i);
  });
});
