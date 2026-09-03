import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { StudioJob } from "./videoData";
import {
  VideoHarness, json, line, revoiceFit, revoiceJob, stubFetch,
} from "./videoHarness";

// THE PART THAT ACTUALLY RUNS.
//
// dub.test.tsx and marquee.test.tsx assert the shape of this surface BEFORE a
// job exists — neither ever stubs the job endpoints, so `jobId` is never set
// and the steps rail, the degraded-connection path, the terminal branches, the
// fit ladder against real data, the download and the run summary had no
// coverage at all. Everything a running job draws is pinned here.

const LINES = [
  line({ id: "a", text: "Get out of my kitchen.", start: 0, end: 4 }),
  line({ id: "b", text: "I was only looking.", start: 4.5, end: 8 }),
  line({ id: "c", text: "Looking is how it starts.", start: 8.5, end: 12 }),
  line({ id: "d", text: "Then I will stop looking.", start: 12.5, end: 16 }),
];

/** The four rungs of the ladder, in the order the lines are sent. */
const LADDER = [
  revoiceFit({ i: 0, method: "verbatim", seconds: 3.5 }),
  revoiceFit({ i: 1, method: "atempo", atempo: 1.08, seconds: 3.4 }),
  revoiceFit({ i: 2, method: "rewrite", rewritten_text: "That is how it starts.",
               seconds: 4.4, spill_seconds: 0.9 }),
  revoiceFit({ i: 3, method: "spill", seconds: 5.2, spill_seconds: 1.7 }),
];

const DONE = revoiceJob({
  status: "done",
  steps: [{ key: "mux", label: "assembling the re-voiced video", state: "done" }],
  result: {
    summary: { lines: 4, verbatim: 1, atempo: 1, rewritten: 2, spilling: 2, failed: 0 },
    fit: LADDER,
  },
});

/** Answer each poll from a queue; the last entry repeats forever, which is
 *  what a terminal job does on the box. */
function queued(jobs: StudioJob[]) {
  let at = 0;
  return () => json(jobs[Math.min(at++, jobs.length - 1)]);
}

async function runDub(poll: () => Response | Promise<Response>, draft = LINES) {
  const stub = stubFetch([
    [/\/api\/revoice$/, () => json({ job_id: "rv1" })],
    [/\/api\/revoice\/rv1/, poll],
  ]);
  const view = render(<VideoHarness draft={draft} />);
  fireEvent.click(screen.getByRole("button", { name: "re-voice" }));
  fireEvent.change(screen.getByLabelText("Dialogue video link"), {
    target: { value: "https://example.test/d" },
  });
  fireEvent.click(screen.getByRole("button", { name: /Dub/ }));
  return { ...stub, view };
}

/** Re-tick the poller the way a tab regaining focus does — the same code path
 *  as its timer, without waiting out the 5s backoff — until it reports the
 *  connection degraded. Three refusals in a row is the documented threshold
 *  (videoData.ts:161-163); the loop has headroom so a scheduling detail cannot
 *  turn this into a flake, and it FAILS if the threshold is never reached. */
async function pollUntilStalled(): Promise<HTMLElement> {
  for (let i = 0; i < 6; i++) {
    const banner = screen.queryByText(/connection degraded/);
    if (banner) return banner;
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
  }
  return screen.getByText(/connection degraded/);
}

const polls = (calls: { url: string; method: string }[]) =>
  calls.filter((c) => c.method === "GET" && /\/api\/revoice\/rv1/.test(c.url)).length;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("running → done", () => {
  it("draws the box's own steps while it runs, then the finished dub", async () => {
    await runDub(queued([revoiceJob(), DONE]));

    // the rail is the SERVER's step labels, with its own progress note
    expect(await screen.findByText("re-performing every line")).toBeTruthy();
    expect(screen.getByText("2/4")).toBeTruthy();

    // …and the next poll lands the finished thing
    const download = await screen.findByText("download the dub", undefined, { timeout: 4000 });
    expect(download.getAttribute("href")).toBe("/api/revoice/rv1/media/video");
    expect(screen.getByText(/4 lines · 1 verbatim · 1 time-stretched · 2 rewritten/)).toBeTruthy();
    expect(screen.queryByText("re-performing every line")).toBeNull();
    // This is the only test here that waits out a SECOND poll, so it pays the
    // poller's real 1.5s first-step backoff (videoData.ts:144) on top of the
    // console render every test in this file pays. Against vitest's 5000ms
    // default that left the `timeout: 4000` above INERT — the test budget
    // always expired first, so the assertion's own allowance could never fire
    // and the test failed by the clock under parallel load. Sized to what it
    // actually waits for, not nudged past one observed failure.
  }, 15_000);

  it("names the lines that overrun without calling them failures", async () => {
    await runDub(queued([DONE]));
    const spill = await screen.findByText(/2 lines still run past their slot/);
    expect(spill.className).toContain("amber");
    expect(screen.queryByText(/could not be re-performed/)).toBeNull();
  });

  it("puts failed lines in rose, as lines that are not in the file", async () => {
    await runDub(queued([revoiceJob({
      status: "done",
      result: { summary: { lines: 4, verbatim: 3, atempo: 0, rewritten: 0, spilling: 0, failed: 1 },
                fit: [...LADDER.slice(0, 3), revoiceFit({ i: 3, method: null, error: "the engine refused this line" })] },
    })]));
    const failed = await screen.findByText(/1 line could not be re-performed/);
    expect(failed.className).toContain("rose");
  });
});

describe("the fit ladder, rung by rung", () => {
  it("labels every rung from the run's own report", async () => {
    await runDub(queued([DONE]));
    expect(await screen.findByText("verbatim")).toBeTruthy();
    expect(screen.getByText("atempo ×1.08")).toBeTruthy();
    expect(screen.getByText("rewritten · spills 0.9s")).toBeTruthy();
    expect(screen.getByText("spills 1.7s")).toBeTruthy();
  });

  it("claims nothing for a line that was not in the run", async () => {
    await runDub(queued([revoiceJob({
      status: "done",
      result: { summary: { lines: 1, verbatim: 1, atempo: 0, rewritten: 0, spilling: 0, failed: 0 },
                fit: [LADDER[0]] },
    })]));
    await screen.findByText("verbatim");
    // three lines were sent but only one verdict came back: the rest stay blank
    expect(screen.queryByTestId("fit-d")).toBeNull();
  });
});

describe("the estimate and the track truth", () => {
  // The ladder's spill is computed per line in isolation BEFORE anything is
  // assembled; the mux then measures what is really in the mp4. When they
  // disagree the track is the fact — and an old payload that carries no track
  // fields at all must still render its estimate rather than nothing.
  it("renders the ladder's estimate for a job that was never measured", async () => {
    await runDub(queued([DONE]));            // LADDER carries no track_* fields
    expect(await screen.findByText("rewritten · spills 0.9s")).toBeTruthy();
    expect(screen.getByText(/2 lines still run past their slot/)).toBeTruthy();
  });

  it("prefers the measured number when the two disagree", async () => {
    await runDub(queued([revoiceJob({
      status: "done",
      result: {
        summary: { lines: 2, verbatim: 2, atempo: 0, rewritten: 0,
                   spilling: 2, spilling_in_track: 1, clipped: 1, silent_in_track: 0, failed: 0 },
        fit: [
          // the ladder predicted an overrun the assembled track does not have
          revoiceFit({ i: 0, spill_seconds: 1.4, track_spill_seconds: 0,
                       track_clipped_seconds: 0, in_track: true }),
          // …and lost 2s of this one at the end of the video, which the ladder
          // (which only ever compared the line to its own slot) never saw
          revoiceFit({ i: 1, spill_seconds: 0, track_spill_seconds: 0,
                       track_clipped_seconds: 2, in_track: true }),
        ],
      },
    })]));
    expect(await screen.findByText("verbatim")).toBeTruthy();      // not "spills 1.4s"
    expect(screen.queryByText(/spills 1.4s/)).toBeNull();
    expect(screen.getByText("verbatim · clipped 2s")).toBeTruthy();
    expect(screen.getByText(/1 line still run past their slot/)).toBeTruthy();
    expect(screen.getByText(/cut short where the video ends/)).toBeTruthy();
  });

  it("never lets a line that is not in the file read as a rendered one", async () => {
    await runDub(queued([revoiceJob({
      status: "done",
      result: {
        summary: { lines: 1, verbatim: 1, atempo: 0, rewritten: 0, spilling: 0,
                   spilling_in_track: 0, clipped: 0, silent_in_track: 1, failed: 0 },
        fit: [revoiceFit({ i: 0, method: "verbatim", in_track: false, track_clipped_seconds: 3.5 })],
      },
    })]));
    expect(await screen.findByText("not in the track")).toBeTruthy();
    expect(screen.queryByText("verbatim")).toBeNull();
    expect(screen.getByText(/not audible in the finished track/)).toBeTruthy();
  });
});

describe("the terminal branches", () => {
  it("shows the box's own error text", async () => {
    await runDub(queued([revoiceJob({ status: "error", error: "the video could not be fetched" })]));
    expect(await screen.findByText("the video could not be fetched")).toBeTruthy();
  });

  it("says an aged-out dub aged out", async () => {
    await runDub(queued([revoiceJob({ status: "expired" })]));
    expect(await screen.findByText(/aged out on the box/)).toBeTruthy();
  });

  it("stops polling once the job has landed", async () => {
    const { calls } = await runDub(queued([DONE]));
    await screen.findByText("download the dub");
    const after = polls(calls);
    // the fresh-step cadence is 1.5s: 2.5s of silence is two missed polls
    await act(async () => { await new Promise((r) => setTimeout(r, 2500)); });
    expect(polls(calls)).toBe(after);
  });
});

describe("the connection, not the job", () => {
  it("reports a degraded connection after three failures in a row", async () => {
    // FOUND A REAL ONE: with every poll failing there is no `job` object, and
    // both panels branched on THAT — so a dub already accepted by the box drew
    // the "here is the sheet you are writing" copy and an enabled Dub button.
    // The stalled flag had nowhere to render at all.
    await runDub(() => Promise.reject(new TypeError("Failed to fetch")));
    expect(await screen.findByText(/waiting for the box to report/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /cancel dub/ })).toBeTruthy();

    const degraded = await pollUntilStalled();
    // it says the failure is OURS, and that the box is still working
    expect(degraded.textContent).toMatch(/keeps running on the box/);
  });

  it("recovers silently when the box answers again", async () => {
    let fail = true;
    await runDub(() => (fail ? Promise.reject(new TypeError("Failed to fetch")) : json(DONE)));
    await pollUntilStalled();
    fail = false;
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    await waitFor(() => expect(screen.queryByText(/connection degraded/)).toBeNull());
  });
});

describe("polling after unmount", () => {
  it("schedules nothing once the console is gone", async () => {
    const { calls, view } = await runDub(queued([revoiceJob()]));
    await screen.findByText("re-performing every line");
    const after = polls(calls);
    view.unmount();
    await act(async () => { await new Promise((r) => setTimeout(r, 2500)); });
    expect(polls(calls)).toBe(after);
  });
});
