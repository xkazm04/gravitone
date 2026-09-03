// First tests for the gym's data layer. Everything risky in this surface lives
// here — the in-flight gate that keeps an honest UI from ever being the caller
// the backend 409s, the 409-vs-everything-else branch, and the partial failure
// where one session's transcript is unreadable and the room must still be a
// room. None of it was visible to `tsc`.
//
// Harness shape follows app/keys/_variants/KeysLedger.test.tsx: the real hooks,
// the real component, `fetch` stubbed at the /api boundary. Nothing was
// refactored to make this testable.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, renderHook, screen, waitFor } from "@testing-library/react";

// Firebase never initializes in a test run (no config) and getAuth throws on an
// absent API key — the roster module reaches it through useAuth/voiceVault, so
// without this the file fails at IMPORT time. Nothing under test here signs in.
vi.mock("@/lib/firebase", () => ({
  db: {}, auth: {}, googleProvider: {}, firebaseReady: false,
}));

import { invalidateRoster, type Character } from "@/app/voices/_data/characters";

import SessionsPhase from "../_forensics/SessionsPhase";
import { useForensics, useGymRuns } from "./data";
import type { GymRun, RecordingSummary, TranscriptAnswer } from "./types";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function run(over: Partial<GymRun> = {}): GymRun {
  return {
    schema: "gravitone-gym-run/1",
    run_id: "run_1",
    agent_id: "a_1",
    source_recording: "conv_1",
    source_name: "conv_1",
    conversation_id: null,
    brain: { backend: "scripted" },
    wire: {
      rate: 16000, frame_ms: 20, pace: 0, realtime: false, polite: true,
      audio_s: 4, frames: 200, trailing_silence_ms: 300,
    },
    timings_source: "recorder",
    turns: [],
    totals: {
      turns: 2, candidate_turns: 1, agent_turns: 1, interruptions: 0,
      answer_s: { n: 1, mean: 0.4, p50: 0.4, max: 0.4 },
      transcribe_s: { n: 1, mean: 0.2, p50: 0.2, max: 0.2 },
      audio_s_total: 4, wall_s: 5, audio_events: 3,
    },
    drift_vs_source: { available: false, why: "no reference" },
    events: {},
    ...over,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useGymRuns — the in-flight gate", () => {
  it("a second click while a replay runs sends no second request", async () => {
    const gate = deferred<Response>();
    const fetchMock = vi.fn(async () => gate.promise);
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useGymRuns());
    let first!: Promise<unknown>;
    let second!: Promise<unknown>;
    act(() => {
      first = result.current.replay("conv_1", { pace: 0, polite: true });
      second = result.current.replay("conv_1", { pace: 0, polite: true });
    });

    // The gate's whole job: the backend runs one replay per replica and would
    // rightly 409 the second caller. The UI must never BE that caller.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await second).toBeNull();

    await act(async () => {
      gate.resolve(json({ run: run() }));
      await first;
    });
    expect(result.current.runs).toHaveLength(1);
    expect(result.current.state.phase).toBe("idle");
  });

  it("reopens the gate once the replay lands", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      void input;
      return json({ run: run() });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useGymRuns());

    await act(async () => {
      await result.current.replay("conv_1", { pace: 0, polite: true });
    });
    await act(async () => {
      await result.current.replay("conv_1", { pace: 0, polite: true });
    });
    // Second replay + the comparison it scores against the first.
    expect(fetchMock.mock.calls.filter((c) => String(c[0]) === "/api/gym/replay")).toHaveLength(2);
  });
});

describe("useGymRuns — how a failure is told", () => {
  it("a 409 is the backend being busy, not the replay being broken", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ detail: "a replay is already running" }, 409)),
    );
    const { result } = renderHook(() => useGymRuns());
    await act(async () => {
      await result.current.replay("conv_1", { pace: 0, polite: true });
    });

    expect(result.current.state).toEqual({
      phase: "error",
      message: "a replay is already running",
      busy: true,
    });
  });

  it("any other failure is not reported as busy", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ detail: "the recording could not be read (request 7c1)" }, 500)),
    );
    const { result } = renderHook(() => useGymRuns());
    await act(async () => {
      await result.current.replay("conv_1", { pace: 0, polite: true });
    });

    expect(result.current.state.phase).toBe("error");
    expect(result.current.state).toMatchObject({ busy: false });
    expect(result.current.state).toMatchObject({
      message: "the recording could not be read (request 7c1)",
    });

    act(() => result.current.dismissError());
    expect(result.current.state.phase).toBe("idle");
  });
});

// ---------------------------------------------------------------------------
// The room, with one transcript missing.
// ---------------------------------------------------------------------------

function recording(id: string, over: Partial<RecordingSummary> = {}): RecordingSummary {
  return {
    conversation_id: id,
    recorded_at: 1_770_000_000,
    audio: ["user.wav", "agent.wav"],
    status: "complete",
    agent_id: "a_1",
    duration_s: 12,
    turns: 4,
    ...over,
  };
}

const transcript: TranscriptAnswer = {
  conversation_id: "conv_ok",
  turns: [
    { role: "candidate", text: "Hi.", at_s: 0, audio_s: 1, transcribe_s: 0.2 },
    {
      role: "agent",
      text: "Hello there.",
      at_s: 2,
      answer_s: 0.4,
      spoke: [
        {
          voice_id: "v_ana",
          tts: "pocket-tts",
          emotion: "excited",
          used: "happy",
          fallback: true,
        },
      ],
    },
  ],
};

function Room() {
  const { sessions, recordings, loading, error, refresh } = useForensics();
  return (
    <SessionsPhase
      sessions={sessions}
      recordingOn={recordings?.recording ?? false}
      recordingsDir={recordings?.directory ?? ""}
      loading={loading}
      error={error}
      refresh={refresh}
      onInspect={() => {}}
    />
  );
}

describe("useForensics — one unreadable transcript is not an unreadable room", () => {
  beforeEach(() => {
    invalidateRoster();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url === "/api/gym/agents") {
          return json({ agents: [{ agent_id: "a_1", voice_id: "v_ana" }], brain: {}, enabled: true });
        }
        if (url === "/api/gym/recordings") {
          return json({
            recording: true,
            directory: "/srv/recordings",
            conversations: [recording("conv_ok"), recording("conv_bad")],
          });
        }
        if (url === "/api/gym/recordings/conv_ok") return json(transcript);
        if (url === "/api/gym/recordings/conv_bad") {
          return json({ detail: "transcript.json is truncated" }, 500);
        }
        if (url.startsWith("/api/characters")) {
          return json([
            { character_id: "c_ana", name: "Ana", voices: [{ voice_id: "v_ana" }] },
          ] as unknown as Character[]);
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
  });

  it("renders every session, states the failure, and diagnoses the rest", async () => {
    render(<Room />);
    await waitFor(() => expect(screen.getByText(/2 sessions/)).toBeInTheDocument());

    // Both rows are present — the failed read did not delete a session.
    expect(screen.getByTitle("conv_ok")).toBeInTheDocument();
    expect(screen.getByTitle("conv_bad")).toBeInTheDocument();

    // The failure is STATED, and never as "clean" or as a zero.
    expect(screen.getByText("transcript unreadable")).toBeInTheDocument();

    // …while the readable session was still diagnosed, with the Character the
    // roster named (which is what the internal lens's copy depends on).
    expect(screen.getAllByText("Ana")).toHaveLength(2);
    expect(screen.getByText(/1 with findings/)).toBeInTheDocument();

    // And the room itself did not report itself broken.
    expect(screen.queryByText(/could not reach the forensic room/)).toBeNull();
    expect(screen.queryByText(/Retry/)).toBeNull();
  });
});
