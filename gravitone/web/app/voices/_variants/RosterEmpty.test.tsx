import { beforeAll, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import RosterEmpty from "./RosterEmpty";

function stubMatchMedia(reduced: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: reduced,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}
beforeAll(() => stubMatchMedia(false));

const COPY = "No characters yet — clone a recording or import a pack to make one.";

describe("RosterEmpty", () => {
  it("keeps the roster's own sentence as the caption", () => {
    render(<RosterEmpty>{COPY}</RosterEmpty>);
    expect(screen.getByText(COPY)).toBeInTheDocument();
  });

  it("is a drawing plus ONE line of prose — never two captions", () => {
    const { container } = render(<RosterEmpty>{COPY}</RosterEmpty>);
    expect(container.querySelectorAll("p")).toHaveLength(1);
    expect(container.querySelector("svg")).toHaveAttribute("aria-hidden");
  });

  it("stays inside its height budget for an empty-state drawing", () => {
    const { container } = render(<RosterEmpty>{COPY}</RosterEmpty>);
    const [, , , h] = (container.querySelector("svg")?.getAttribute("viewBox") ?? "").split(" ");
    expect(Number(h)).toBeLessThanOrEqual(120);
  });

  it("stilled, the drawing is COMPLETE — every stroke and both labels present", () => {
    stubMatchMedia(true);
    const { container } = render(<RosterEmpty>{COPY}</RosterEmpty>);
    // 1 wave + 5 fan curves + 5 slots = 11 strokes, all of them rendered.
    expect(container.querySelectorAll("path")).toHaveLength(11);
    expect(screen.getByText("one recording")).toBeInTheDocument();
    expect(screen.getByText("emotion slots")).toBeInTheDocument();
    expect(screen.getByText("baseline")).toBeInTheDocument();
    expect(screen.getByText(COPY)).toBeInTheDocument();
    stubMatchMedia(false);
  });
});
