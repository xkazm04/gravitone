import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  DetectionFinding, SovereignLimits, segmentFailureNote, usableCounts,
  type Detection,
} from "./shared";

const base: Detection = {
  outcome: "spans", spans: 4, speech_seconds: 31.2,
  noise_floor_db: -61, speech_db: -18, threshold_db: -41, adaptive: true,
};

describe("SovereignLimits", () => {
  it("renders the limits it is GIVEN — the backend constant is the only source", () => {
    // The studio used to keep a hand-typed copy of SOVEREIGN_LIMITS, free to
    // drift from service/ingest.py. Nothing in this component authors a limit.
    const { container } = render(
      <SovereignLimits limits={["one emotion only — …", "single speaker — …"]} />);
    expect(screen.getByText(/one emotion only/)).toBeInTheDocument();
    expect(screen.getByText(/single speaker/)).toBeInTheDocument();
    expect(container.querySelectorAll("li")).toHaveLength(2);
  });

  it("renders nothing rather than an empty card when there are no limits", () => {
    const { container } = render(<SovereignLimits limits={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("DetectionFinding", () => {
  it("is a finding about the recording, never styled as a transcript", () => {
    // `unbroken` used to reach the user through sample_text, rendered in
    // italic quotation marks exactly where a transcript goes — as though the
    // speaker had said "no pauses found, the whole recording is one take".
    const { container } = render(
      <DetectionFinding
        detection={{ ...base, outcome: "unbroken", spans: 1 }}
        note="no pauses were found in this recording, so the whole of it is used as one take."
      />);
    expect(container.querySelector(".italic")).toBeNull();
    expect(container.textContent).not.toContain("“");
    expect(container.textContent).toMatch(/^finding · /);
  });

  it("gives each outcome its own headline", () => {
    const headlines = (["spans", "unbroken", "silent", "too_short"] as const).map((outcome) => {
      const { container, unmount } = render(
        <DetectionFinding detection={{ ...base, outcome }} />);
      const h = container.querySelector("div > div")!.textContent!;
      unmount();
      return h;
    });
    expect(new Set(headlines).size).toBe(4);
    expect(headlines[1]).toMatch(/no pauses/);
    expect(headlines[2]).toMatch(/no speech/);
    expect(headlines[3]).toMatch(/too short/);
  });

  it("shows the levels the outcome was decided on", () => {
    const { container } = render(<DetectionFinding detection={base} />);
    expect(container.textContent).toContain("4 spans");
    expect(container.textContent).toContain("31.2s of speech");
    expect(container.textContent).toContain("-41 dBFS, derived from this recording");
    expect(container.textContent).toContain("background -61 dBFS, speech -18 dBFS");
  });

  it("does not claim a threshold was derived from a clip it could not measure", () => {
    const { container } = render(
      <DetectionFinding detection={{
        ...base, adaptive: false, noise_floor_db: null, speech_db: null, threshold_db: -35,
      }} />);
    expect(container.textContent).toContain("fixed fallback");
    expect(container.textContent).not.toContain("derived from this recording");
    expect(container.textContent).not.toContain("null");
  });

  it("does not report speech spans for an outcome that found no speech", () => {
    const { container } = render(
      <DetectionFinding detection={{ ...base, outcome: "silent", spans: 0, speech_seconds: 0 }}
        note="this recording is silence." />);
    expect(container.textContent).not.toContain("0 spans");
    expect(container.textContent).toContain("this recording is silence.");
  });
});

describe("segmentFailureNote", () => {
  it("says nothing when nothing failed", () => {
    expect(segmentFailureNote({})).toBeNull();
    expect(segmentFailureNote({ label_errors: 0 })).toBeNull();
  });

  it("never claims a failed segment reached the baseline stem", () => {
    // service/ingest.py's `usable` filter admits neither an undecodable nor an
    // unclassified segment to ANY stem — the old copy said the opposite.
    const note = segmentFailureNote({ label_errors: 3, extract_errors: 1, classify_errors: 2 })!;
    expect(note).not.toMatch(/fell back|falling back/);
    expect(note).toContain("left out of every stem");
    expect(note).toContain("never folded into the baseline");
  });

  it("tells decode failures and classify failures apart", () => {
    const note = segmentFailureNote({ label_errors: 3, extract_errors: 1, classify_errors: 2 })!;
    expect(note).toContain("1 couldn’t be decoded");
    expect(note).toContain("2 couldn’t be classified");
    const onlyDecode = segmentFailureNote({ label_errors: 2, extract_errors: 2, classify_errors: 0 })!;
    expect(onlyDecode).toContain("2 couldn’t be decoded");
    expect(onlyDecode).not.toContain("classified");
  });

  it("pluralizes, and falls back to the legacy total alone", () => {
    expect(segmentFailureNote({ label_errors: 1, extract_errors: 1 })).toContain("1 segment left");
    const legacy = segmentFailureNote({ label_errors: 2 })!;
    expect(legacy).toContain("2 segments left out of every stem.");
  });
});

describe("usableCounts", () => {
  it("stops counting failed segments as baseline", () => {
    // _settle parks a failed segment on `baseline` so progress still advances;
    // the stem builder then excludes it. The tally must match the stem.
    expect(usableCounts({ baseline: 5, happy: 2 }, 2)).toEqual({ baseline: 3, happy: 2 });
  });

  it("drops baseline entirely when every baseline segment failed", () => {
    expect(usableCounts({ baseline: 2, sad: 1 }, 2)).toEqual({ sad: 1 });
  });

  it("is a no-op with no failures, and never goes negative", () => {
    const counts = { baseline: 4 };
    expect(usableCounts(counts, 0)).toBe(counts);
    expect(usableCounts({ baseline: 1 }, 9)).toEqual({});
  });
});
