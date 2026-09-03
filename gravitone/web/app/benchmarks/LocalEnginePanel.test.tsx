import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import LocalEnginePanel from "./LocalEnginePanel";
import { registerEngine } from "@/lib/engineSeam";
import type { EngineProbeReport, ProbeSignal } from "@/lib/engineProbe";

// The panel's only job is to not overclaim. Every test here is a sentence the
// page must not be able to say.

const probeLocalEngine = vi.hoisted(() => vi.fn());
vi.mock("@/lib/engineProbe", async (orig) => ({
  ...(await orig<typeof import("@/lib/engineProbe")>()),
  probeLocalEngine,
}));

const sig = (id: string, ok: boolean | null, over: Partial<ProbeSignal> = {}): ProbeSignal => ({
  id, label: id, weight: "required", ok, detail: `${id} detail`, ...over,
});

function report(over: Partial<EngineProbeReport> = {}): EngineProbeReport {
  return {
    capable: true, missing: [], unknown: [],
    signals: [sig("wasm", true), sig("simd", true)],
    notes: ["This is a capability check only. Nothing was run — the local engine is not shipped yet."],
    ...over,
  };
}

afterEach(() => { registerEngine(null); });

describe("LocalEnginePanel", () => {
  it("shows a checking state before the probe answers", () => {
    probeLocalEngine.mockReturnValue(new Promise(() => {}));
    render(<LocalEnginePanel />);
    expect(screen.getByRole("status")).toHaveTextContent(/checking this browser/i);
  });

  it("names the verdict in words, not only colour", async () => {
    probeLocalEngine.mockResolvedValue(report());
    render(<LocalEnginePanel />);
    expect(await screen.findByText("capable")).toBeInTheDocument();
    expect(screen.getByText(/every requirement a local engine has is present/i)).toBeInTheDocument();
  });

  it("names WHAT is missing rather than just failing", async () => {
    probeLocalEngine.mockResolvedValue(report({
      capable: false, missing: ["simd"],
      signals: [sig("wasm", true, { label: "WebAssembly" }), sig("simd", false, { label: "vector math" })],
    }));
    render(<LocalEnginePanel />);
    expect(await screen.findByText("not capable")).toBeInTheDocument();
    // The label, not the id — a visitor cannot act on "simd".
    expect(screen.getAllByText("vector math").length).toBeGreaterThan(0);
    expect(screen.getByText(/this browser is missing something/i)).toBeInTheDocument();
  });

  it("renders an unknown as unknown — never as a pass or a fail", async () => {
    probeLocalEngine.mockResolvedValue(report({
      unknown: ["storage"],
      signals: [sig("storage", null, { label: "storage", weight: "recommended" })],
    }));
    render(<LocalEnginePanel />);
    expect(await screen.findByText("unknown")).toBeInTheDocument();
    expect(screen.getByText(/Not answered by this browser/)).toBeInTheDocument();
  });

  it("prints every honest caveat the probe returned", async () => {
    probeLocalEngine.mockResolvedValue(report({ notes: ["note one.", "note two."] }));
    render(<LocalEnginePanel />);
    expect(await screen.findByText("note one.")).toBeInTheDocument();
    expect(screen.getByText("note two.")).toBeInTheDocument();
  });

  it("states that the local engine is not shipped and what it would cost", async () => {
    probeLocalEngine.mockResolvedValue(report());
    render(<LocalEnginePanel />);
    expect(await screen.findByText(/what a local engine would need/i)).toBeInTheDocument();
    expect(screen.getByText(/MB of weights/)).toBeInTheDocument();
    expect(screen.getByText(/COOP\/COEP/)).toBeInTheDocument();
  });

  it("says where audio is made TODAY, from the engine actually registered", async () => {
    // A capable browser must not leave a visitor thinking this page is
    // synthesizing locally.
    probeLocalEngine.mockResolvedValue(report());
    render(<LocalEnginePanel />);
    expect(await screen.findByText(/server engine/)).toBeInTheDocument();
    expect(screen.getByText(/not in this tab/)).toBeInTheDocument();
  });

  it("reports a probe that failed as unknown support, not as incapable", async () => {
    probeLocalEngine.mockRejectedValue(new Error("boom"));
    render(<LocalEnginePanel />);
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(/unknown, not absent/i));
    expect(screen.queryByText("not capable")).toBeNull();
  });

  it("is a labelled landmark with a heading the probe answers", async () => {
    probeLocalEngine.mockResolvedValue(report());
    render(<LocalEnginePanel />);
    const region = await screen.findByRole("region", { name: /could this browser run a local engine/i });
    expect(region).toBeInTheDocument();
  });
});
