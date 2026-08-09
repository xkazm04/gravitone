import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { VideoHarness, json, line, revoiceJob, stubFetch, voiceoverJob } from "./videoHarness";

// CANCEL IS A REQUEST, NOT A WISH.
//
// Both hooks used to null their job state and THEN fire a DELETE nobody
// checked — so a refused cancel drew "new reel" / a fresh sheet over a render
// that was still burning on the box. The doctrine's own canonical rollback
// (app/keys/_variants/data.ts::revokeKey) names the TRUE state; these tests
// pin that the video round does the same.

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function startReel(deleteAnswer: () => Response) {
  const stub = stubFetch([
    [/\/api\/voiceover\/from-url/, () => json({ job_id: "vo1" })],
    [/\/api\/voiceover\/vo1$/, (_u, init) =>
      init?.method === "DELETE" ? deleteAnswer() : json(voiceoverJob())],
  ]);
  render(<VideoHarness />);
  fireEvent.change(screen.getByLabelText("Footage link"), {
    target: { value: "https://example.test/v" },
  });
  fireEvent.click(screen.getByRole("button", { name: "load reel" }));
  await screen.findByRole("button", { name: "cancel" });
  return stub;
}

describe("a refused cancel keeps the reel", () => {
  it("says the reel is still rendering instead of clearing the view", async () => {
    await startReel(() => json({}, 503));
    fireEvent.click(screen.getByRole("button", { name: "cancel" }));

    const banner = await screen.findByText(/still rendering on the box/);
    // the backend's own reason survives in front of our statement of the state
    expect(banner.textContent).toContain("Gravitone backend unreachable");
    // …and the job is exactly where it was: still cancellable, still polling
    expect(screen.getByRole("button", { name: "cancel" })).toBeTruthy();
    expect(screen.getByText("A silent street")).toBeTruthy();
    expect(screen.queryByLabelText("Footage link")).toBeNull();
  });

  it("clears the view when the box agrees", async () => {
    await startReel(() => json({ status: "cancelled" }));
    fireEvent.click(screen.getByRole("button", { name: "cancel" }));
    // back to the door — the reel really is gone
    await waitFor(() => expect(screen.getByLabelText("Footage link")).toBeTruthy());
    expect(screen.queryByText(/still rendering on the box/)).toBeNull();
  });

  it("treats an aged-out job as gone rather than as a failure", async () => {
    // 404 is errors.job_expired(): there is nothing left running to lie about.
    await startReel(() => json({ status: "expired", detail: "no such job" }, 404));
    fireEvent.click(screen.getByRole("button", { name: "cancel" }));
    await waitFor(() => expect(screen.getByLabelText("Footage link")).toBeTruthy());
  });

  it("sends one DELETE however many times the button is pressed", async () => {
    let release: (() => void) | null = null;
    const stub = await startReel(() => {
      // a DELETE that has not answered yet — the window a double-click lives in
      return new Promise<Response>((r) => { release = () => r(json({ status: "cancelled" })); }) as never;
    });
    const button = screen.getByRole("button", { name: "cancel" });
    fireEvent.click(button);
    await waitFor(() => expect(release).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: /cancel/ }));
    fireEvent.click(screen.getByRole("button", { name: /cancel/ }));
    release!();
    await waitFor(() => expect(screen.getByLabelText("Footage link")).toBeTruthy());
    expect(stub.calls.filter((c) => c.method === "DELETE").length).toBe(1);
  });
});

describe("a cancelled job is a state the panel can draw", () => {
  it("names a dub the box marked cancelled", async () => {
    stubFetch([
      [/\/api\/revoice$/, () => json({ job_id: "rv1" })],
      [/\/api\/revoice\/rv1$/, () => json(revoiceJob({ status: "cancelled" }))],
    ]);
    render(<VideoHarness draft={[line()]} />);
    fireEvent.click(screen.getByRole("button", { name: "re-voice" }));
    fireEvent.change(screen.getByLabelText("Dialogue video link"), {
      target: { value: "https://example.test/d" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Dub/ }));
    expect(await screen.findByText(/this dub was cancelled/)).toBeTruthy();
  });
});
