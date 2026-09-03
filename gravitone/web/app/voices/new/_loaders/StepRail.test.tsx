import { beforeAll, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import StepRail from "./StepRail";
import type { LoaderStep } from "./ScanReport";

// useStillMotion subscribes to a media query; jsdom ships no matchMedia.
// "motion is fine" is the same answer the server gives.
function stubMatchMedia(reduced: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: reduced,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}
beforeAll(() => stubMatchMedia(false));

const steps: LoaderStep[] = [
  { key: "transcribe", label: "Transcribe", state: "done" },
  { key: "isolate", label: "Isolate speaker", state: "active" },
  { key: "label", label: "Detect emotions", state: "pending" },
];

describe("StepRail", () => {
  it("draws one segment per backend step and nothing else", () => {
    const { container } = render(<StepRail steps={steps} />);
    // Three segments; the extra paths are the pulse riding the active one.
    const segments = container.querySelectorAll("path");
    expect(segments.length).toBeGreaterThanOrEqual(3);
    expect(container.querySelectorAll("li")).toHaveLength(3);
  });

  it("renders the backend's own labels as text, never only as colour", () => {
    render(<StepRail steps={steps} />);
    for (const s of steps) expect(screen.getByText(s.label)).toBeInTheDocument();
  });

  it("names each step's state in words for a reader who cannot see the rail", () => {
    render(<StepRail steps={steps} />);
    expect(screen.getByText(/— done/)).toBeInTheDocument();
    expect(screen.getByText(/— running/)).toBeInTheDocument();
    expect(screen.getByText(/— not started/)).toBeInTheDocument();
  });

  it("draws nothing before the first poll describes the pipeline", () => {
    // An empty rail would claim a shape nobody has reported yet.
    const { container } = render(<StepRail steps={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("the drawing itself is aria-hidden — the list underneath is the content", () => {
    const { container } = render(<StepRail steps={steps} />);
    expect(container.querySelector("svg")).toHaveAttribute("aria-hidden");
  });

  it("stilled, the rail is COMPLETE — every step still drawn, pulse parked", () => {
    stubMatchMedia(true);
    const { container } = render(<StepRail steps={steps} />);
    const paths = container.querySelectorAll("path");
    expect(paths.length).toBeGreaterThanOrEqual(3);
    // A stilled Draw is a finished stroke: no dash animation left behind on a
    // solid segment, and the pulse parks mid-step rather than at the end (the
    // step is running, not done).
    const pulse = [...paths].find((p) => p.getAttribute("stroke-dasharray") === "0.001 2");
    expect(pulse).toBeTruthy();
    expect(pulse?.getAttribute("stroke-dashoffset")).toBe("-0.5");
    expect(screen.getByText("Isolate speaker")).toBeInTheDocument();
    stubMatchMedia(false);
  });
});
