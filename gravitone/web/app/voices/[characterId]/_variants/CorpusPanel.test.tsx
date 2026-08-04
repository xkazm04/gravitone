// The retention panel's states, in the order a user meets them.
//
// The promises pinned here are honesty promises, not layout ones: an empty
// corpus is not an error, a failed READ is not an empty corpus, a deletion
// shows its consequence before AND after the click, a failed deletion says the
// recording is still kept, and a rebuild reports its terminal state — including
// the one where it stopped part-way and the emotions it finished were kept.
import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import CorpusPanel from "./CorpusPanel";
import type { CorpusView, DeletionReport } from "@/app/voices/new/_state/corpus";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json" },
  });
}

const clip = (over: Record<string, unknown> = {}) => ({
  clip_sha256: "abc123", added: "2026-07-01T10:00:00Z", mode: "cloud", bytes: 1024 * 512,
  seconds: 41.5, segments: 12, segments_recorded: 14,
  emotions: { angry: { segments: 5, seconds: 20.5 }, neutral: { segments: 7, seconds: 21 } },
  fidelity: { stem_identity: { angry: 0.914 }, measures: "speaker identity (cosine)" },
  voices: ["v_1", "v_2"],
  consent: { consented_at: "2026-07-01T10:00:00Z", statement: "I own this voice.", clip_sha256: "abc123" },
  stems: [{ emotion: "angry", seconds: 20.5, segments: 5, identity: 0.914 }],
  ...over,
});

const view = (over: Partial<CorpusView> = {}): CorpusView => ({
  character_id: "sarah", corpus_rev: 3, clips: [clip()],
  totals: { clips: 1, segments: 12, seconds: 41.5, bytes: 1024 * 512 },
  cap_bytes: 1024 * 1024 * 100, over_cap: false,
  ...over,
} as CorpusView);

const report: DeletionReport = {
  removed: { clip_sha256: "abc123", segments: 12, segment_labels: 14, stems: 1,
             seconds: 41.5, bytes: 1024 * 512, added: "2026-07-01T10:00:00Z",
             files_deleted: true },
  reason: null, corpus_rev: 4, remaining: { clips: 0, bytes: 0 },
};

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

async function click(name: RegExp) {
  const el = await screen.findByRole("button", { name });
  await act(async () => { el.click(); });
  return el;
}

describe("what is kept", () => {
  it("renders an EMPTY corpus as an answer, not as a failure", async () => {
    // Every character created before the opt-in existed lands here.
    vi.stubGlobal("fetch", vi.fn(async () => json(view({
      clips: [], totals: { clips: 0, segments: 0, seconds: 0, bytes: 0 },
    }))));
    render(<CorpusPanel characterId="sarah" />);

    await screen.findByText(/Nothing is kept for this character/i);
    expect(screen.queryByRole("alert")).toBeNull();
    // No rebuild offer either: there is nothing to rebuild FROM.
    expect(screen.queryByRole("button", { name: /rebuild/i })).toBeNull();
  });

  it("does not render a failed READ as an empty corpus", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ detail: "the corpus index is unreadable" }, 500)));
    render(<CorpusPanel characterId="sarah" />);

    await screen.findByText(/the corpus index is unreadable/i);
    expect(screen.queryByText(/Nothing is kept/i)).toBeNull();
    expect(screen.getByText(/failed read, not an empty corpus/i)).toBeInTheDocument();
  });

  it("itemizes a kept recording, its measured identity and its receipt", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(view())));
    render(<CorpusPanel characterId="sarah" />);

    await screen.findByText(/12 segments/);
    expect(screen.getByText(/identity 0.91/)).toBeInTheDocument();
    expect(screen.getByText(/I own this voice/)).toBeInTheDocument();
    // Labels the scan produced whose audio was NOT kept stay distinguishable
    // from segments that were.
    expect(screen.getByText(/2 labels without audio/i)).toBeInTheDocument();
  });

  it("says a rebuild is refused while the corpus is over its cap", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(view({ over_cap: true }))));
    render(<CorpusPanel characterId="sarah" />);
    await screen.findByText(/over the .* cap/i);
  });
});

describe("deletion", () => {
  it("states the consequence BEFORE the click, and the report after it", async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(json(view()))
      .mockResolvedValueOnce(json(report));
    vi.stubGlobal("fetch", f);
    render(<CorpusPanel characterId="sarah" />);

    await click(/delete recording/i);
    // What goes, and what does NOT: the voices cloned from it are untouched.
    expect(screen.getByText(/Delete 12 segments \(41.5s\)/i)).toBeInTheDocument();
    expect(screen.getByText(/2 voices already cloned from it stay/i)).toBeInTheDocument();

    await click(/delete it/i);
    await screen.findByText(/12 segments of audio \(41.5s\), 14 labels and 1 stem removed/i);
    expect(screen.getByText(/0 recordings still kept/i)).toBeInTheDocument();
    // The row is gone with it.
    expect(screen.queryByText(/I own this voice/)).toBeNull();
    expect(f.mock.calls[1][1].method).toBe("DELETE");
  });

  it("names the TRUE state when the deletion fails — the recording is still kept", async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(json(view()))
      .mockResolvedValueOnce(json({ detail: "the corpus lock could not be taken" }, 409));
    vi.stubGlobal("fetch", f);
    render(<CorpusPanel characterId="sarah" />);

    await click(/delete recording/i);
    await click(/delete it/i);
    await screen.findByText(/still kept on this box/i);
    // Not removed from the list on a failure — that is the whole point.
    expect(screen.getByText(/I own this voice/)).toBeInTheDocument();
  });

  it("deletes once for a double-click", async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(json(view()))
      .mockImplementation(() => new Promise(() => {})); // hangs: the gate must hold
    vi.stubGlobal("fetch", f);
    render(<CorpusPanel characterId="sarah" />);

    await click(/delete recording/i);
    const go = await screen.findByRole("button", { name: /delete it/i });
    await act(async () => { go.click(); go.click(); });
    // one read + exactly one DELETE
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("keeps the recording when the confirm is declined", async () => {
    const f = vi.fn(async () => json(view()));
    vi.stubGlobal("fetch", f);
    render(<CorpusPanel characterId="sarah" />);

    await click(/delete recording/i);
    await click(/keep it/i);
    expect(f).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/I own this voice/)).toBeInTheDocument();
  });
});

describe("rebuild from the kept audio", () => {
  it("relays the service's refusal verbatim instead of starting a doomed job", async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(json(view()))
      .mockResolvedValueOnce(json({
        detail: "this character's corpus is 900 bytes, over its 500-byte cap",
      }, 409));
    vi.stubGlobal("fetch", f);
    render(<CorpusPanel characterId="sarah" />);

    await click(/rebuild from kept audio/i);
    await screen.findByText(/over its 500-byte cap/i);
  });

  it("starts a job, polls it, and reports what it rebuilt", async () => {
    const onRebuilt = vi.fn();
    const f = vi.fn()
      .mockResolvedValueOnce(json(view()))
      .mockResolvedValueOnce(json({ job_id: "j9", mode: "rederive", corpus_rev: 3 }))
      .mockResolvedValue(json({
        status: "committed", step: null, steps: [], partial: { emotions_done: 2, emotions_total: 2 },
        speakers: null, duration: 0, result: null, error: null,
        committed: [{ voice_id: "v1", emotion: "angry" }, { voice_id: "v2", emotion: "neutral" }],
      }));
    vi.stubGlobal("fetch", f);
    // Fake timers from the start: the poller's first tick is 1.5s out, and a
    // clock swapped in mid-test would leave that timeout on the real one.
    vi.useFakeTimers();
    render(<CorpusPanel characterId="sarah" onRebuilt={onRebuilt} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });

    await act(async () => {
      screen.getByRole("button", { name: /rebuild from kept audio/i }).click();
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });

    expect(screen.getByText(/rebuilt 2 voices from the kept audio/i)).toBeInTheDocument();
    // The rack above is now showing replaced voices — the page is told once.
    expect(onRebuilt).toHaveBeenCalledTimes(1);
  });

  it("says a rebuild that stopped part-way KEPT what it finished", async () => {
    // A re-derivation is never rolled back (service/ingest_api.py::_do_rederive),
    // so "it failed, nothing changed" would describe a character that does not
    // exist.
    const f = vi.fn()
      .mockResolvedValueOnce(json(view()))
      .mockResolvedValueOnce(json({ job_id: "j9", mode: "rederive" }))
      .mockResolvedValue(json({
        status: "error", step: null, steps: [], partial: {},
        speakers: null, duration: 0, result: null,
        error: "voice re-derivation failed",
      }));
    vi.stubGlobal("fetch", f);
    vi.useFakeTimers();
    render(<CorpusPanel characterId="sarah" />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });

    await act(async () => {
      screen.getByRole("button", { name: /rebuild from kept audio/i }).click();
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });

    expect(screen.getByText(/voice re-derivation failed/i)).toBeInTheDocument();
    expect(screen.getByText(/already rebuilt was kept/i)).toBeInTheDocument();
  });
});
