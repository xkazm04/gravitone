import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { DetectionFinding, SovereignLimits, type Detection } from "./shared";

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
