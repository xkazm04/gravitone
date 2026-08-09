"use client";

// ── The live conversation client (batch-2 contract D4) ───────────────────────
//
// One duplex call, end to end: the microphone at 16 kHz PCM16 going out as
// base64 `user_audio_chunk` frames, the agent's PCM coming back into a
// jitter-buffered Web Audio queue, and every completed agent turn handed up as
// text + samples so the caller can turn it into a real `Take`.
//
// Three decisions worth stating, because each one is a bug if reversed:
//
//  1. **The socket dials the SERVICE, not the studio.** `signed_url` carries the
//     service's own origin and a short-lived HMAC ticket (service/convai.py); a
//     browser cannot put an API key on a WS handshake, which is the whole reason
//     the ticket exists. So this module is handed a URL, never a key.
//
//  2. **Playback is buffered, not immediate.** Frames arrive in ~200 ms bursts
//     over a network; playing each one "now" produces a gap at every burst
//     boundary. A scheduling clock (`nextAt`) plus one JITTER_S of lead means the
//     agent sounds continuous, and an interruption can still cut it dead because
//     every scheduled source is held and stoppable.
//
//  3. **The agent's audio is registered with the AudioBus as a STREAM.** The bus
//     taps media elements and capture streams (batch-1 C4), so the playback
//     graph exposes itself through a MediaStreamAudioDestinationNode. That is
//     what makes the whole frame react to a voice that never was an <audio>
//     element. The mic is registered too — tapped, never routed to the speakers.
//
// Teardown is not best-effort: worklet stopped and disconnected, mic tracks
// stopped (the browser's recording indicator must go out), scheduled sources
// stopped, streams unregistered from the bus, context closed, socket closed.
// A live conversation that survives navigation is a hot microphone nobody asked
// for.

import type { AudioBusApi } from "@/components/ui/AudioBus";
import {
  base64ToPcm16, concatPcm16, DEFAULT_WIRE_RATE, floatToPcm16, parseAudioFormat,
  pcm16ToBase64, pcm16ToFloat,
} from "./pcm";
import { WORKLET_NAME, workletModuleUrl } from "./worklet";

/** Playback lead. Under ~60 ms a single late frame is audible as a gap; over
 *  ~250 ms the agent feels laggy even when the service was fast. */
const JITTER_S = 0.12;
/** A turn is complete this long after its last audio frame. The protocol has no
 *  end-of-turn event — `agent_response` arrives BEFORE the audio — so silence is
 *  the only signal, and it is also what the next event supersedes. */
const TURN_IDLE_MS = 900;
/** 100 ms frames: small enough that the server's gate sees turn ends promptly,
 *  large enough that a two-minute call is not 60k messages. */
const FRAME_SAMPLES = 1600;

export type LiveStatus = "idle" | "connecting" | "live" | "ended";

/** Every way a live call can be refused, NAMED. "line busy" is a real answer
 *  (the service caps concurrent sessions) and must never look like a crash. */
export type LiveRefusal = {
  kind: "busy" | "policy" | "mic" | "transport" | "unsupported";
  message: string;
};

export type LiveTurn = {
  id: string;
  role: "user" | "agent";
  text: string;
  /** Agent turns only: the raw samples that were spoken. */
  pcm?: Int16Array;
  rate: number;
  /** The user talked over this turn — only part of it was ever heard. */
  interrupted: boolean;
  at: number;
  /** User turns only: this is what we think they are saying SO FAR, not what
   *  they said. The service emits these under CONVAI_PARTIAL_DECODE and records
   *  none of them; a consumer must render it as a guess and must not bank it. */
  interim?: boolean;
};

export type ConversationHooks = {
  onStatus?: (status: LiveStatus) => void;
  onRefusal?: (refusal: LiveRefusal) => void;
  /**
   * A user transcript, or a COMPLETED agent turn (text + samples).
   *
   * UPSERT BY `id`. A user utterance can be announced several times — an
   * interim guess, then the confirmed transcript — and every announcement of
   * the same utterance carries the same id, so a consumer that appends blindly
   * will show the same sentence two or three times over.
   */
  onTurn?: (turn: LiveTurn) => void;
  /** The agent's reply text, the moment it arrives — before its audio. */
  onAgentText?: (text: string) => void;
  /** The agent has audio scheduled, or has just run out of it. Edge-triggered
   *  off the `speaking` getter — the surface says who has the floor. */
  onSpeaking?: (speaking: boolean) => void;
  onInterruption?: () => void;
  onMeta?: (meta: { conversationId: string; rate: number }) => void;
};

/** Injected so the whole module is testable with a fake socket and a fake
 *  AudioContext — jsdom has neither, and mocking `window` globals for a class
 *  that owns a microphone is how these tests become flaky. */
export type ConversationDeps = {
  WebSocketImpl?: typeof WebSocket;
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  createAudioContext?: () => AudioContext;
  bus?: Pick<AudioBusApi, "registerStream" | "unregisterStream">;
};

type PendingTurn = { text: string; chunks: Int16Array[]; interrupted: boolean; at: number };

let seq = 0;
const nextId = () => {
  seq += 1;
  return `live-${Date.now()}-${seq}`;
};

export class LiveConversation {
  private hooks: ConversationHooks;
  private deps: ConversationDeps;

  private ws: WebSocket | null = null;
  private ctx: AudioContext | null = null;
  private mic: MediaStream | null = null;
  private worklet: AudioWorkletNode | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;
  private playGain: GainNode | null = null;
  private tap: MediaStreamAudioDestinationNode | null = null;
  private moduleUrl: string | null = null;

  private sources = new Set<AudioBufferSourceNode>();
  private nextAt = 0;
  private rate = DEFAULT_WIRE_RATE;
  private pending: PendingTurn | null = null;
  /** The user's utterance in flight. Interim guesses UPDATE this row (same id);
   *  the confirmed transcript replaces its text. Cleared when the agent answers,
   *  because the next thing the user says is a different utterance. */
  private userTurn: { id: string; text: string; final: boolean } | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  /** The last `speaking` value the hook was told about. */
  private spoke = false;
  private muted = false;
  private stopped = false;
  private state: LiveStatus = "idle";

  constructor(hooks: ConversationHooks = {}, deps: ConversationDeps = {}) {
    this.hooks = hooks;
    this.deps = deps;
  }

  get status(): LiveStatus {
    return this.state;
  }

  /** Whether the agent has audio scheduled right now (for a "speaking" chip). */
  get speaking(): boolean {
    return this.sources.size > 0;
  }

  /** Announce a CHANGE in `speaking`, and nothing else. The getter above is the
   *  one definition of the state; this only decides when to say it out loud, so
   *  the chip can never disagree with the audio graph. */
  private syncSpeaking(): void {
    const now = this.speaking;
    if (now === this.spoke) return;
    this.spoke = now;
    this.hooks.onSpeaking?.(now);
  }

  /**
   * Open the microphone, then the socket.
   *
   * `init` is the `conversation_config_override.agent` object — the voice, the
   * scene prompt, the opening line. It is sent as the FIRST frame, before any
   * audio, because the service resolves the agent's mouth from it and a turn
   * that began first would be spoken by the wrong voice.
   */
  async start(signedUrl: string, init?: Record<string, unknown>): Promise<void> {
    if (this.state !== "idle") return;
    this.setStatus("connecting");

    const opened = await this.openMic();
    if (!opened || this.stopped) return;

    const WS = this.deps.WebSocketImpl ?? (typeof WebSocket !== "undefined" ? WebSocket : null);
    if (!WS) {
      this.refuse({ kind: "unsupported", message: "This browser has no WebSocket support." });
      return;
    }

    let ws: WebSocket;
    try {
      ws = new WS(signedUrl);
    } catch {
      this.refuse({
        kind: "transport",
        message:
          "The conversation socket could not be opened. The service must be reachable from the " +
          "browser — set CONVAI_PUBLIC_URL on the service if it sits behind a proxy.",
      });
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.send({
        type: "conversation_initiation_client_data",
        conversation_config_override: { agent: init ?? {} },
      });
      this.setStatus("live");
    };
    ws.onmessage = (event: MessageEvent) => this.onFrame(event.data);
    ws.onerror = () => {
      // `onerror` carries no detail by design (the spec hides it); the close
      // event that follows carries the code, so the sentence is written there.
      // Saying nothing here avoids two banners for one failure.
    };
    ws.onclose = (event: CloseEvent) => this.onClose(event.code, event.reason);
  }

  /** Stop sending audio without ending the call (push-to-talk / privacy). */
  setMuted(muted: boolean): void {
    this.muted = muted;
    for (const track of this.mic?.getAudioTracks() ?? []) track.enabled = !muted;
  }

  get isMuted(): boolean {
    return this.muted;
  }

  /** End the call and release EVERYTHING. Idempotent. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.clearIdle();
    this.finalizeTurn();

    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
      try {
        ws.close(1000, "hung up");
      } catch {
        /* already closing */
      }
    }

    this.flushPlayback();

    if (this.worklet) {
      try {
        this.worklet.port.postMessage("stop");
      } catch {
        /* the worklet may already be gone */
      }
      this.worklet.port.onmessage = null;
      try {
        this.worklet.disconnect();
      } catch {
        /* ignore */
      }
      this.worklet = null;
    }
    try {
      this.micSource?.disconnect();
    } catch {
      /* ignore */
    }
    this.micSource = null;

    // The recording indicator goes out here. Anything less leaves a hot mic.
    for (const track of this.mic?.getTracks() ?? []) {
      try {
        track.stop();
      } catch {
        /* ignore */
      }
    }
    if (this.mic) this.deps.bus?.unregisterStream(this.mic);
    this.mic = null;
    if (this.tap) this.deps.bus?.unregisterStream(this.tap.stream);
    this.tap = null;
    this.playGain = null;

    if (this.moduleUrl) {
      try {
        URL.revokeObjectURL(this.moduleUrl);
      } catch {
        /* ignore */
      }
      this.moduleUrl = null;
    }
    try {
      void this.ctx?.close?.()?.catch?.(() => {});
    } catch {
      /* ignore */
    }
    this.ctx = null;
    this.setStatus("ended");
  }

  // ── microphone ─────────────────────────────────────────────────────────────
  private async openMic(): Promise<boolean> {
    const getMedia =
      this.deps.getUserMedia ??
      (typeof navigator !== "undefined" && navigator.mediaDevices
        ? (c: MediaStreamConstraints) => navigator.mediaDevices.getUserMedia(c)
        : null);
    if (!getMedia) {
      this.refuse({
        kind: "mic",
        message:
          "This browser exposes no microphone API. A live conversation needs one — " +
          "a secure context (https, or localhost) is required.",
      });
      return false;
    }

    try {
      // AEC is requested best-effort. The SERVICE has none, so when the browser
      // cannot cancel speaker bleed the agent hears itself and barges in on its
      // own voice — which is why the stage recommends headphones out loud.
      this.mic = await getMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
    } catch (e) {
      const denied = (e as { name?: string } | null)?.name === "NotAllowedError";
      this.refuse({
        kind: "mic",
        message: denied
          ? "Microphone access was denied, so there is nothing to hear. Allow it for this site and dial again."
          : "The microphone could not be opened. Another app may be holding it.",
      });
      return false;
    }

    const create =
      this.deps.createAudioContext ??
      (() => {
        const Ctor =
          typeof window !== "undefined"
            ? window.AudioContext ??
              (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
            : undefined;
        if (!Ctor) throw new Error("no AudioContext");
        return new Ctor();
      });
    try {
      this.ctx = create();
      if (this.ctx.state === "suspended") await this.ctx.resume?.();
    } catch {
      this.refuse({ kind: "unsupported", message: "This browser has no Web Audio support." });
      return false;
    }

    // The bus taps the mic (never routes it — that is feedback), so the input
    // meter on the stage is the real waveform.
    this.deps.bus?.registerStream(this.mic);

    if (!(await this.attachWorklet())) return false;
    this.attachPlayback();
    return true;
  }

  private async attachWorklet(): Promise<boolean> {
    const ctx = this.ctx;
    const mic = this.mic;
    if (!ctx || !mic) return false;
    if (typeof AudioWorkletNode === "undefined" || !ctx.audioWorklet) {
      this.refuse({
        kind: "unsupported",
        message:
          "This browser has no AudioWorklet, so the microphone cannot be resampled to 16 kHz " +
          "without stuttering. Live needs a current Chrome, Edge, Firefox or Safari.",
      });
      return false;
    }
    try {
      this.moduleUrl = workletModuleUrl();
      await ctx.audioWorklet.addModule(this.moduleUrl);
      this.micSource = ctx.createMediaStreamSource(mic);
      this.worklet = new AudioWorkletNode(ctx, WORKLET_NAME, {
        numberOfInputs: 1,
        numberOfOutputs: 0,
        processorOptions: { targetRate: DEFAULT_WIRE_RATE, frameSamples: FRAME_SAMPLES },
      });
      this.worklet.port.onmessage = (e: MessageEvent) => this.onMicFrame(e.data);
      this.micSource.connect(this.worklet);
    } catch {
      this.refuse({
        kind: "unsupported",
        message: "The microphone processor could not be installed, so nothing would be heard.",
      });
      return false;
    }
    return true;
  }

  private onMicFrame(data: unknown): void {
    if (this.muted || this.stopped) return;
    if (!(data instanceof Float32Array)) return;
    this.send({ user_audio_chunk: pcm16ToBase64(floatToPcm16(data)) });
  }

  // ── playback ───────────────────────────────────────────────────────────────
  private attachPlayback(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    try {
      this.playGain = ctx.createGain();
      this.playGain.gain.value = 1;
      this.playGain.connect(ctx.destination);
      // Destination FIRST (above), tap second: if the tap cannot be built the
      // agent is still audible. Silence is the one regression Live cannot ship.
      if (typeof ctx.createMediaStreamDestination === "function") {
        this.tap = ctx.createMediaStreamDestination();
        this.playGain.connect(this.tap);
        this.deps.bus?.registerStream(this.tap.stream);
      }
    } catch {
      this.playGain = null; // no playback graph — handled per frame below
    }
  }

  private enqueueAudio(pcm: Int16Array): void {
    const ctx = this.ctx;
    const gain = this.playGain;
    if (!ctx || !gain || pcm.length === 0) return;
    try {
      const buffer = ctx.createBuffer(1, pcm.length, this.rate);
      buffer.getChannelData(0).set(pcm16ToFloat(pcm));
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(gain);
      const now = ctx.currentTime;
      // Behind the clock (a slow burst, or the first frame of a turn): re-lead
      // by JITTER_S instead of scheduling in the past, which plays instantly and
      // overlaps whatever is still running.
      if (this.nextAt < now + JITTER_S) this.nextAt = now + JITTER_S;
      const at = this.nextAt;
      this.nextAt += buffer.duration;
      this.sources.add(src);
      this.syncSpeaking();
      src.onended = () => {
        this.sources.delete(src);
        this.syncSpeaking();
      };
      src.start(at);
    } catch {
      /* one undecodable frame is a gap, not a dead call */
    }
  }

  /** Stop everything scheduled and reset the clock — barge-in, and teardown. */
  private flushPlayback(): void {
    for (const src of this.sources) {
      try {
        src.onended = null;
        src.stop();
      } catch {
        /* already finished */
      }
      try {
        src.disconnect();
      } catch {
        /* ignore */
      }
    }
    this.sources.clear();
    this.nextAt = 0;
    // Barge-in and teardown both land here: the floor is free the instant the
    // audio stops, and the chip must not outlive the sound it describes.
    this.syncSpeaking();
  }

  // ── protocol ───────────────────────────────────────────────────────────────
  private onFrame(raw: unknown): void {
    if (typeof raw !== "string") return; // the service sends text frames only
    let msg: Record<string, unknown>;
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return;
      msg = parsed as Record<string, unknown>;
    } catch {
      return; // one malformed frame drops the frame, never the call
    }
    const event = <T,>(key: string): T | undefined => msg[key] as T | undefined;

    switch (msg.type) {
      case "conversation_initiation_metadata": {
        const meta = event<Record<string, string>>("conversation_initiation_metadata_event") ?? {};
        this.rate = parseAudioFormat(meta.agent_output_audio_format);
        this.hooks.onMeta?.({ conversationId: String(meta.conversation_id ?? ""), rate: this.rate });
        return;
      }
      case "user_transcript": {
        const evt = event<Record<string, unknown>>("user_transcription_event") ?? {};
        const text = String(evt.user_transcript ?? "").trim();
        // `is_final` is present ONLY on a guess: convai.py::_send_interim sends
        // `is_final: false` while the caller is still talking (gated behind
        // CONVAI_PARTIAL_DECODE), and the confirmed transcript carries no such
        // field at all. So anything that is not an explicit `false` is a
        // completed utterance — which is also why an old client that never read
        // the flag still saw exactly the events it always saw.
        if (evt.is_final === false) {
          if (!text) return;
          const held = this.userTurn;
          if (held?.final) {
            // A guess arriving after the confirmed transcript is either a
            // duplicate of it (drop — the row is already right) or the start of
            // the NEXT utterance, guessed before the agent got a word in.
            if (held.text === text) return;
            this.userTurn = null;
          }
          if (!this.userTurn) this.userTurn = { id: nextId(), text: "", final: false };
          this.userTurn.text = text;
          // Deliberately NO finalizeTurn(): a partial decode runs while the
          // caller is mid-sentence, so banking here would cut the agent's reply
          // in half for a sentence the service itself refuses to record.
          this.hooks.onTurn?.({
            id: this.userTurn.id, role: "user", text, rate: this.rate,
            interrupted: false, at: Date.now(), interim: true,
          });
          return;
        }
        // The user speaking ENDS the agent's turn: whatever the agent was
        // saying is over, so it is banked before the transcript is announced.
        this.finalizeTurn();
        // An empty confirmed transcript says nothing; any guess already shown
        // stays a guess rather than being replaced by silence.
        if (!text) return;
        if (this.userTurn?.final && this.userTurn.text === text) return; // a duplicate frame
        const id = this.userTurn && !this.userTurn.final ? this.userTurn.id : nextId();
        this.userTurn = { id, text, final: true };
        this.hooks.onTurn?.({
          id, role: "user", text, rate: this.rate, interrupted: false, at: Date.now(),
          interim: false,
        });
        return;
      }
      case "agent_response": {
        const text = String(
          (event<Record<string, unknown>>("agent_response_event") ?? {}).agent_response ?? "",
        ).trim();
        this.finalizeTurn();
        // The agent has answered, so whatever the user said is closed: the next
        // transcript — guess or confirmed — belongs to a new utterance.
        this.userTurn = null;
        this.pending = { text, chunks: [], interrupted: false, at: Date.now() };
        if (text) this.hooks.onAgentText?.(text);
        return;
      }
      case "audio": {
        const b64 = String(
          (event<Record<string, unknown>>("audio_event") ?? {}).audio_base_64 ?? "",
        );
        const pcm = b64 ? base64ToPcm16(b64) : null;
        if (!pcm || pcm.length === 0) return;
        // Audio with no `agent_response` before it should not be possible (the
        // service guarantees the ordering) but it must not be dropped either.
        if (!this.pending) {
          this.pending = { text: "", chunks: [], interrupted: false, at: Date.now() };
        }
        this.pending.chunks.push(pcm);
        this.enqueueAudio(pcm);
        this.armIdle();
        return;
      }
      case "interruption": {
        // Barge-in: cut the audio dead, then bank the partial turn MARKED. The
        // take is the whole reply (that is what the agent said); the chip is
        // what says only part of it was heard.
        this.flushPlayback();
        if (this.pending) this.pending.interrupted = true;
        this.finalizeTurn();
        this.hooks.onInterruption?.();
        return;
      }
      case "ping": {
        const id = (event<Record<string, unknown>>("ping_event") ?? {}).event_id;
        this.send({ type: "pong", event_id: id });
        return;
      }
      default:
        return; // a protocol feature we do not implement is not an error
    }
  }

  private onClose(code: number, reason: string): void {
    if (this.stopped) return;
    // 1013 is the service's honest "at its conversation limit" (convai.py
    // _CLOSE_BUSY). It is a queue answer, not a failure, and the stage says so
    // in those words rather than showing a broken socket.
    if (code === 1013) {
      this.refuse({
        kind: "busy",
        message:
          reason ||
          "Line busy — this service is already holding as many conversations as it allows. " +
          "Try again in a moment.",
      });
      return;
    }
    if (code === 1008) {
      this.refuse({ kind: "policy", message: reason || "The service refused this conversation." });
      return;
    }
    if (code !== 1000 && code !== 1005) {
      this.refuse({
        kind: "transport",
        message: reason
          ? `The conversation ended: ${reason}`
          : "The conversation socket closed unexpectedly.",
      });
      return;
    }
    this.stop();
  }

  private send(message: Record<string, unknown>): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== 1) return; // 1 = OPEN
    try {
      ws.send(JSON.stringify(message));
    } catch {
      /* the close handler owns saying why */
    }
  }

  // ── turn assembly ──────────────────────────────────────────────────────────
  private armIdle(): void {
    this.clearIdle();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      this.finalizeTurn();
    }, TURN_IDLE_MS);
  }

  private clearIdle(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  /** Bank the agent turn in flight, if there is one. */
  private finalizeTurn(): void {
    const pending = this.pending;
    this.pending = null;
    this.clearIdle();
    if (!pending) return;
    if (!pending.text && pending.chunks.length === 0) return;
    this.hooks.onTurn?.({
      id: nextId(),
      role: "agent",
      text: pending.text,
      pcm: pending.chunks.length ? concatPcm16(pending.chunks) : undefined,
      rate: this.rate,
      interrupted: pending.interrupted,
      at: pending.at,
    });
  }

  private setStatus(status: LiveStatus): void {
    if (this.state === status) return;
    this.state = status;
    this.hooks.onStatus?.(status);
  }

  /** Say why, then release everything. A refusal that leaves the mic open is
   *  the worst of both outcomes. */
  private refuse(refusal: LiveRefusal): void {
    this.hooks.onRefusal?.(refusal);
    this.stop();
  }
}
