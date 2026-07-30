// Web Audio fakes. jsdom has no AudioContext at all, so the Signal Layer would
// be untestable — and the one failure it must never ship (a registered <audio>
// that is analysed but not re-routed to the speakers, i.e. silent playback) is
// invisible without asserting on the graph. These fakes record every connection
// so tests can state exactly what the bus wired up.

export class FakeNode {
  connections: unknown[] = [];
  connect(target: unknown) {
    this.connections.push(target);
    return target;
  }
  disconnect(target?: unknown) {
    if (target === undefined) this.connections = [];
    else this.connections = this.connections.filter((c) => c !== target);
  }
  connectedTo(target: unknown) {
    return this.connections.includes(target);
  }
}

export class FakeGain extends FakeNode {
  gain = { value: 1 };
}

export class FakeAnalyser extends FakeNode {
  fftSize = 2048;
  smoothingTimeConstant = 0;
  /** loudness of the fake signal, 0..127 offset from the 128 zero-line */
  amplitude = 60;
  /** which half of the spectrum carries energy — drives the centroid */
  bright = false;
  timeReads = 0;
  get frequencyBinCount() {
    return this.fftSize / 2;
  }
  getByteTimeDomainData(buf: Uint8Array) {
    this.timeReads += 1;
    buf.fill(128 + this.amplitude);
  }
  getByteFrequencyData(buf: Uint8Array) {
    buf.fill(0);
    const half = Math.floor(buf.length / 2);
    for (let i = 0; i < half; i += 1) buf[this.bright ? half + i : i] = 200;
  }
}

export class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  state: AudioContextState = "suspended";
  destination = new FakeNode();
  analyser: FakeAnalyser | null = null;
  gains: FakeGain[] = [];
  elementSources: (FakeNode & { el?: unknown })[] = [];
  streamSources: (FakeNode & { stream?: unknown })[] = [];
  resumeCalls = 0;
  closeCalls = 0;
  /** set to throw from createMediaElementSource (already-owned element) */
  failElementSource = false;

  constructor() {
    FakeAudioContext.instances.push(this);
  }
  createAnalyser() {
    this.analyser = new FakeAnalyser();
    return this.analyser as unknown as AnalyserNode;
  }
  createGain() {
    const g = new FakeGain();
    this.gains.push(g);
    return g as unknown as GainNode;
  }
  createMediaElementSource(el: unknown) {
    if (this.failElementSource) throw new Error("element already owned");
    const n = new FakeNode() as FakeNode & { el?: unknown };
    n.el = el;
    this.elementSources.push(n);
    return n as unknown as MediaElementAudioSourceNode;
  }
  createMediaStreamSource(stream: unknown) {
    const n = new FakeNode() as FakeNode & { stream?: unknown };
    n.stream = stream;
    this.streamSources.push(n);
    return n as unknown as MediaStreamAudioSourceNode;
  }
  resume() {
    this.resumeCalls += 1;
    this.state = "running";
    return Promise.resolve();
  }
  close() {
    this.closeCalls += 1;
    this.state = "closed";
    return Promise.resolve();
  }
  static reset() {
    FakeAudioContext.instances = [];
  }
  static get last(): FakeAudioContext | undefined {
    return FakeAudioContext.instances[FakeAudioContext.instances.length - 1];
  }
}
