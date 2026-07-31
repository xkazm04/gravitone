// The microphone's downsampler, as an AudioWorklet.
//
// WHY a worklet and not a ScriptProcessorNode or a main-thread resample: the
// capture graph runs at the device rate (44.1 / 48 kHz) and the service's ears
// want 16 kHz mono. Resampling on the main thread means the frame cadence — the
// thing the server's turn-taking gate measures silence with — jitters with every
// React render and every peak decode. In the audio thread it does not.
//
// The processor is shipped as SOURCE TEXT and installed from a Blob URL rather
// than a static /worklet.js asset, because it belongs to this feature: a file in
// public/ is a second place to keep in sync and a 404 away from a mic that
// records nothing.

export const WORKLET_NAME = "gt-live-downsampler";

/**
 * Linear-interpolating decimator with a fractional read position that SURVIVES
 * across render quanta (128 samples). Resetting the position each block — the
 * obvious version — drops or repeats a fraction of a sample 375 times a second,
 * which is audible as a rasp and measurably hurts transcription.
 */
export const WORKLET_SOURCE = `
class GtLiveDownsampler extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    const target = opts.targetRate || 16000;
    this.ratio = sampleRate / target;
    this.frame = opts.frameSamples || 1600;
    this.out = new Float32Array(this.frame);
    this.n = 0;
    this.pos = 0;
    this.tail = new Float32Array(0);
    this.stopped = false;
    this.port.onmessage = (e) => {
      if (e && e.data === "stop") this.stopped = true;
    };
  }

  process(inputs) {
    if (this.stopped) return false;
    const channel = inputs[0] && inputs[0][0];
    if (!channel || channel.length === 0) return true;
    const merged = new Float32Array(this.tail.length + channel.length);
    merged.set(this.tail);
    merged.set(channel, this.tail.length);
    let p = this.pos;
    while (Math.floor(p) + 1 < merged.length) {
      const i = Math.floor(p);
      const frac = p - i;
      this.out[this.n] = merged[i] * (1 - frac) + merged[i + 1] * frac;
      this.n += 1;
      if (this.n === this.frame) {
        this.port.postMessage(this.out.slice(0));
        this.n = 0;
      }
      p += this.ratio;
    }
    const consumed = Math.floor(p);
    this.tail = merged.slice(consumed);
    this.pos = p - consumed;
    return true;
  }
}
registerProcessor(${JSON.stringify(WORKLET_NAME)}, GtLiveDownsampler);
`;

/** The module URL to hand `audioWorklet.addModule`. Revoked by the caller. */
export function workletModuleUrl(): string {
  return URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: "text/javascript" }));
}
