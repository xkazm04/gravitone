// The live client, driven with a fake socket and a fake Web Audio graph.
//
// Everything asserted here is invisible in code review and catastrophic in the
// product: the init frame arriving AFTER audio (the agent speaks in the wrong
// voice), a ping never answered (the service hangs up on us), barge-in that
// leaves the old audio scheduled (the agent talks over itself), a "line busy"
// close reading as a crash, and a teardown that leaves the microphone hot.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LiveConversation, type LiveRefusal, type LiveTurn } from "./conversation";
import { base64ToPcm16, pcm16ToBase64 } from "./pcm";

// ── fakes ────────────────────────────────────────────────────────────────────
class FakeWS {
  static last: FakeWS | null = null;
  readyState = 0;
  sent: string[] = [];
  closedWith: { code?: number; reason?: string } | null = null;
  onopen: ((e: Event) => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  onclose: ((e: CloseEvent) => void) | null = null;

  constructor(readonly url: string) {
    FakeWS.last = this;
  }
  send(data: string) { this.sent.push(data); }
  close(code?: number, reason?: string) {
    this.readyState = 3;
    this.closedWith = { code, reason };
  }
  /** The server accepted the socket. */
  open() {
    this.readyState = 1;
    this.onopen?.(new Event("open"));
  }
  /** One server frame. */
  emit(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent);
  }
  emitRaw(data: unknown) {
    this.onmessage?.({ data } as MessageEvent);
  }
  serverClose(code: number, reason = "") {
    this.readyState = 3;
    this.onclose?.({ code, reason } as CloseEvent);
  }
  frames(): Array<Record<string, unknown>> {
    return this.sent.map((s) => JSON.parse(s));
  }
}

class FakeSource {
  started: number | null = null;
  stopped = false;
  buffer: { duration: number } | null = null;
  onended: (() => void) | null = null;
  connect() {}
  disconnect() {}
  start(at: number) { this.started = at; }
  stop() { this.stopped = true; }
}

class FakeWorkletNode {
  static last: FakeWorkletNode | null = null;
  port = { onmessage: null as ((e: MessageEvent) => void) | null, postMessage: vi.fn() };
  disconnected = false;
  constructor(_ctx: unknown, readonly name: string, readonly options: unknown) {
    FakeWorkletNode.last = this;
  }
  connect() {}
  disconnect() { this.disconnected = true; }
  /** One 16 kHz frame out of the audio thread. */
  post(frame: Float32Array) {
    this.port.onmessage?.({ data: frame } as MessageEvent);
  }
}

class FakeCtx {
  static last: FakeCtx | null = null;
  state = "running";
  currentTime = 0;
  destination = {};
  sources: FakeSource[] = [];
  closed = false;
  tapStream = { id: "tap" };
  audioWorklet = { addModule: vi.fn(async () => {}) };
  constructor() { FakeCtx.last = this; }
  resume = vi.fn(async () => {});
  close = vi.fn(async () => { this.closed = true; });
  createMediaStreamSource() { return { connect: () => {}, disconnect: () => {} }; }
  createGain() { return { gain: { value: 1 }, connect: () => {}, disconnect: () => {} }; }
  createMediaStreamDestination() { return { stream: this.tapStream, connect: () => {} }; }
  createBuffer(_ch: number, length: number, rate: number) {
    const data = new Float32Array(length);
    return { duration: length / rate, getChannelData: () => data };
  }
  createBufferSource() {
    const s = new FakeSource();
    this.sources.push(s);
    return s;
  }
}

function fakeMic() {
  const track = { enabled: true, stop: vi.fn() };
  const stream = { id: "mic", getAudioTracks: () => [track], getTracks: () => [track] };
  return { track, stream };
}

type Harness = {
  call: LiveConversation;
  ws: FakeWS;
  ctx: FakeCtx;
  worklet: FakeWorkletNode;
  turns: LiveTurn[];
  refusals: LiveRefusal[];
  statuses: string[];
  mic: ReturnType<typeof fakeMic>;
  bus: { registerStream: ReturnType<typeof vi.fn>; unregisterStream: ReturnType<typeof vi.fn> };
};

async function dial(init: Record<string, unknown> = {}): Promise<Harness> {
  const mic = fakeMic();
  const turns: LiveTurn[] = [];
  const refusals: LiveRefusal[] = [];
  const statuses: string[] = [];
  const bus = { registerStream: vi.fn(), unregisterStream: vi.fn() };
  const call = new LiveConversation(
    {
      onTurn: (t) => turns.push(t),
      onRefusal: (r) => refusals.push(r),
      onStatus: (s) => statuses.push(s),
    },
    {
      WebSocketImpl: FakeWS as unknown as typeof WebSocket,
      getUserMedia: async () => mic.stream as unknown as MediaStream,
      createAudioContext: () => new FakeCtx() as unknown as AudioContext,
      bus,
    },
  );
  await call.start("ws://service.local/v1/convai/conversation?agent_id=a&token=t", init);
  const ws = FakeWS.last!;
  return { call, ws, ctx: FakeCtx.last!, worklet: FakeWorkletNode.last!, turns, refusals, statuses, mic, bus };
}

/** Announce a turn the way the service does: text first, then its audio. */
function speak(ws: FakeWS, text: string, samples = 320) {
  ws.emit({ type: "agent_response", agent_response_event: { agent_response: text } });
  const pcm = new Int16Array(samples);
  for (let i = 0; i < samples; i += 1) pcm[i] = (i % 200) - 100;
  ws.emit({ type: "audio", audio_event: { audio_base_64: pcm16ToBase64(pcm), event_id: 1 } });
  return pcm;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("AudioWorkletNode", FakeWorkletNode);
  (URL as unknown as { createObjectURL: unknown }).createObjectURL = vi.fn(() => "blob:worklet");
  (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = vi.fn();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  FakeWS.last = null;
  FakeCtx.last = null;
  FakeWorkletNode.last = null;
});

describe("handshake", () => {
  it("sends the agent override as the FIRST frame, before any audio", async () => {
    const h = await dial({ tts: { voice_id: "v_1" } });
    h.ws.open();
    // A mic frame that lands in the same tick must not overtake the init frame:
    // the service resolves the agent's mouth from it (convai.py::_read_init).
    h.worklet.post(new Float32Array(1600));
    const frames = h.ws.frames();
    expect(frames[0]).toEqual({
      type: "conversation_initiation_client_data",
      conversation_config_override: { agent: { tts: { voice_id: "v_1" } } },
    });
    expect(frames[1]).toHaveProperty("user_audio_chunk");
    expect(h.statuses).toContain("live");
  });

  it("drops mic frames until the socket is open rather than throwing", async () => {
    const h = await dial();
    h.worklet.post(new Float32Array(1600));
    expect(h.ws.sent).toEqual([]);
  });

  it("installs the 16 kHz downsampler and taps the mic on the AudioBus", async () => {
    const h = await dial();
    expect(h.ctx.audioWorklet.addModule).toHaveBeenCalledWith("blob:worklet");
    expect((h.worklet.options as { processorOptions: { targetRate: number } }).processorOptions.targetRate)
      .toBe(16_000);
    // Tapped, never routed to the speakers — that would be feedback.
    expect(h.bus.registerStream).toHaveBeenCalledWith(h.mic.stream);
  });

  it("encodes mic frames as little-endian base64 PCM16", async () => {
    const h = await dial();
    h.ws.open();
    const frame = new Float32Array([0, 0.5, -0.5]);
    h.worklet.post(frame);
    const payload = h.ws.frames().at(-1)!.user_audio_chunk as string;
    expect(Array.from(base64ToPcm16(payload)!)).toEqual([0, 16384, -16384]);
  });

  it("mutes by disabling the track, and the call stays up", async () => {
    const h = await dial();
    h.ws.open();
    h.call.setMuted(true);
    expect(h.mic.track.enabled).toBe(false);
    h.worklet.post(new Float32Array(1600));
    expect(h.ws.frames().some((f) => "user_audio_chunk" in f)).toBe(false);
    expect(h.call.status).toBe("live");
  });
});

describe("protocol", () => {
  it("answers ping with pong, carrying the event id", async () => {
    const h = await dial();
    h.ws.open();
    h.ws.emit({ type: "ping", ping_event: { event_id: 7, ping_ms: 0 } });
    expect(h.ws.frames().at(-1)).toEqual({ type: "pong", event_id: 7 });
  });

  it("reads the conversation's audio rate out of the metadata frame", async () => {
    const rates: number[] = [];
    const mic = fakeMic();
    const call = new LiveConversation(
      { onMeta: (m) => rates.push(m.rate) },
      {
        WebSocketImpl: FakeWS as unknown as typeof WebSocket,
        getUserMedia: async () => mic.stream as unknown as MediaStream,
        createAudioContext: () => new FakeCtx() as unknown as AudioContext,
      },
    );
    await call.start("ws://x");
    FakeWS.last!.open();
    FakeWS.last!.emit({
      type: "conversation_initiation_metadata",
      conversation_initiation_metadata_event: { conversation_id: "c1", agent_output_audio_format: "pcm_24000" },
    });
    expect(rates).toEqual([24_000]);
    call.stop();
  });

  it("banks a user transcript as its own turn", async () => {
    const h = await dial();
    h.ws.open();
    h.ws.emit({ type: "user_transcript", user_transcription_event: { user_transcript: "hello there" } });
    expect(h.turns).toHaveLength(1);
    expect(h.turns[0]).toMatchObject({ role: "user", text: "hello there" });
  });

  it("UPDATES the row for an interim transcript instead of banking a turn", async () => {
    // CONVAI_PARTIAL_DECODE makes the service guess out loud while the caller is
    // still talking (convai.py::_send_interim). Every guess used to be treated
    // as a completed utterance: a row per guess, and the agent's reply cut off
    // mid-sentence by a sentence the service does not even record.
    const h = await dial();
    h.ws.open();
    speak(h.ws, "I am still talking here.");
    h.ws.emit({ type: "user_transcript", user_transcription_event: { user_transcript: "so", is_final: false } });
    h.ws.emit({ type: "user_transcript", user_transcription_event: { user_transcript: "so I", is_final: false } });

    // The agent's turn is untouched: a guess never ends it.
    expect(h.turns.filter((t) => t.role === "agent")).toHaveLength(0);
    const guesses = h.turns.filter((t) => t.role === "user");
    expect(guesses.map((t) => t.text)).toEqual(["so", "so I"]);
    expect(guesses.every((t) => t.interim)).toBe(true);
    // One utterance, one id — the consumer upserts, so this is one row.
    expect(new Set(guesses.map((t) => t.id)).size).toBe(1);

    // The confirmed transcript replaces that same row and NOW ends the agent's
    // turn, exactly as it always did.
    h.ws.emit({ type: "user_transcript", user_transcription_event: { user_transcript: "so I said no" } });
    const final = h.turns.at(-1)!;
    expect(final.id).toBe(guesses[0].id);
    expect(final.interim).toBe(false);
    expect(h.turns.filter((t) => t.role === "agent")).toHaveLength(1);
  });

  it("drops a duplicated transcript rather than printing it twice", async () => {
    const h = await dial();
    h.ws.open();
    const say = (user_transcript: string, extra: Record<string, unknown> = {}) =>
      h.ws.emit({ type: "user_transcript", user_transcription_event: { user_transcript, ...extra } });
    say("hello there");
    say("hello there");                      // the same frame again
    say("hello there", { is_final: false }); // and a guess that arrived late
    expect(h.turns.filter((t) => t.role === "user")).toHaveLength(1);

    // A DIFFERENT sentence after that is a new utterance with its own id.
    say("and another thing");
    const users = h.turns.filter((t) => t.role === "user");
    expect(users).toHaveLength(2);
    expect(users[0].id).not.toBe(users[1].id);
  });

  it("starts a new row when the agent has answered in between", async () => {
    const h = await dial();
    h.ws.open();
    h.ws.emit({ type: "user_transcript", user_transcription_event: { user_transcript: "yes" } });
    speak(h.ws, "Understood.");
    h.ws.emit({ type: "user_transcript", user_transcription_event: { user_transcript: "yes", is_final: false } });
    const users = h.turns.filter((t) => t.role === "user");
    expect(users).toHaveLength(2);
    expect(users[1].id).not.toBe(users[0].id);
    expect(users[1].interim).toBe(true);
  });

  it("completes an agent turn on silence, carrying text AND its samples", async () => {
    const h = await dial();
    h.ws.open();
    const pcm = speak(h.ws, "Tell me about yourself.");
    // The protocol has no end-of-turn event: silence completes it.
    expect(h.turns).toHaveLength(0);
    vi.advanceTimersByTime(1000);
    expect(h.turns).toHaveLength(1);
    expect(h.turns[0].role).toBe("agent");
    expect(h.turns[0].text).toBe("Tell me about yourself.");
    expect(Array.from(h.turns[0].pcm!)).toEqual(Array.from(pcm));
    expect(h.turns[0].interrupted).toBe(false);
  });

  it("completes the agent turn when the user speaks, without waiting for silence", async () => {
    const h = await dial();
    h.ws.open();
    speak(h.ws, "One.");
    h.ws.emit({ type: "user_transcript", user_transcription_event: { user_transcript: "ok" } });
    expect(h.turns.map((t) => t.role)).toEqual(["agent", "user"]);
  });

  it("schedules inbound audio with a jitter lead instead of playing it at once", async () => {
    const h = await dial();
    h.ws.open();
    speak(h.ws, "Two sentences.", 1600);
    speak(h.ws, "", 1600);
    const starts = h.ctx.sources.map((s) => s.started!);
    expect(starts[0]).toBeGreaterThan(0);         // never scheduled in the past
    expect(starts[1]).toBeGreaterThan(starts[0]); // and never overlapping
  });

  it("interruption stops every scheduled source and MARKS the banked turn", async () => {
    const h = await dial();
    h.ws.open();
    speak(h.ws, "I was saying something long.");
    h.ws.emit({ type: "interruption", interruption_event: { reason: "user_speech" } });
    expect(h.ctx.sources.every((s) => s.stopped)).toBe(true);
    expect(h.turns).toHaveLength(1);
    // The take keeps the WHOLE reply — that is what it said — and says only part
    // of it was heard.
    expect(h.turns[0].interrupted).toBe(true);
    expect(h.turns[0].text).toBe("I was saying something long.");
  });

  it("survives a malformed frame and an unknown message type", async () => {
    const h = await dial();
    h.ws.open();
    h.ws.emitRaw("{not json");
    h.ws.emitRaw(new ArrayBuffer(4));
    h.ws.emit({ type: "client_tool_call" });
    h.ws.emit({ type: "audio", audio_event: { audio_base_64: "!!!" } });
    expect(h.refusals).toEqual([]);
    expect(h.call.status).toBe("live");
  });
});

describe("refusals", () => {
  it("names 'line busy' when the service is at its session cap (1013)", async () => {
    const h = await dial();
    h.ws.open();
    h.ws.serverClose(1013, "this service is at its conversation limit");
    expect(h.refusals[0].kind).toBe("busy");
    expect(h.refusals[0].message).toContain("conversation limit");
    // A refusal must not leave the microphone open.
    expect(h.mic.track.stop).toHaveBeenCalled();
  });

  it("says something, and releases the mic, when the socket dies mid-call", async () => {
    // 1006 is the abnormal close a dropped network gives: no code was ever sent.
    // Silence here is the failure mode that matters — a call that is over while
    // the stage still looks live.
    const h = await dial();
    h.ws.open();
    speak(h.ws, "Mid sentence when the wire went");
    h.ws.serverClose(1006, "");
    expect(h.refusals).toHaveLength(1);
    expect(h.refusals[0].message).not.toBe("");
    expect(h.mic.track.stop).toHaveBeenCalled();
    expect(h.call.status).toBe("ended");
    // The turn in flight is still banked: the user had that exchange.
    expect(h.turns.filter((t) => t.role === "agent")).toHaveLength(1);
  });

  it("passes a policy close (1008) through in the service's own words", async () => {
    const h = await dial();
    h.ws.open();
    h.ws.serverClose(1008, "invalid or expired signed URL");
    expect(h.refusals[0]).toEqual({ kind: "policy", message: "invalid or expired signed URL" });
  });

  it("refuses honestly when the microphone is denied, and opens no socket", async () => {
    const refusals: LiveRefusal[] = [];
    const call = new LiveConversation(
      { onRefusal: (r) => refusals.push(r) },
      {
        WebSocketImpl: FakeWS as unknown as typeof WebSocket,
        getUserMedia: async () => {
          const err = new Error("denied");
          err.name = "NotAllowedError";
          throw err;
        },
        createAudioContext: () => new FakeCtx() as unknown as AudioContext,
      },
    );
    await call.start("ws://x");
    expect(refusals[0].kind).toBe("mic");
    expect(refusals[0].message).toContain("denied");
    expect(FakeWS.last).toBeNull();
  });

  it("refuses when the browser has no AudioWorklet (rather than recording silence)", async () => {
    vi.stubGlobal("AudioWorkletNode", undefined);
    const refusals: LiveRefusal[] = [];
    const mic = fakeMic();
    const call = new LiveConversation(
      { onRefusal: (r) => refusals.push(r) },
      {
        WebSocketImpl: FakeWS as unknown as typeof WebSocket,
        getUserMedia: async () => mic.stream as unknown as MediaStream,
        createAudioContext: () => new FakeCtx() as unknown as AudioContext,
      },
    );
    await call.start("ws://x");
    expect(refusals[0].kind).toBe("unsupported");
    expect(mic.track.stop).toHaveBeenCalled();
  });
});

describe("teardown", () => {
  it("releases the microphone, the socket, the streams and the context", async () => {
    const h = await dial();
    h.ws.open();
    speak(h.ws, "half a sentence");
    h.call.stop();

    expect(h.mic.track.stop).toHaveBeenCalled();          // the recording light goes out
    expect(h.ws.closedWith?.code).toBe(1000);
    expect(h.worklet.port.postMessage).toHaveBeenCalledWith("stop");
    expect(h.worklet.disconnected).toBe(true);
    expect(h.ctx.sources.every((s) => s.stopped)).toBe(true);
    expect(h.bus.unregisterStream).toHaveBeenCalledWith(h.mic.stream);
    expect(h.ctx.close).toHaveBeenCalled();
    expect(h.call.status).toBe("ended");
    // The turn in flight is banked, not lost — the user had that exchange.
    expect(h.turns).toHaveLength(1);
  });

  it("is idempotent and stops sending after teardown", async () => {
    const h = await dial();
    h.ws.open();
    h.call.stop();
    h.call.stop();
    h.worklet.post(new Float32Array(1600));
    expect(h.ws.frames().some((f) => "user_audio_chunk" in f)).toBe(false);
  });
});
