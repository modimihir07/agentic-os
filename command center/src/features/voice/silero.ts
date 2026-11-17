/**
 * Silero VAD (v6, MIT) on onnxruntime-web — a neural "is this speech?" score per
 * 32 ms window. It ignores keyboard clacks, fans, music and breathing that fool a
 * loudness meter, and it calls end-of-speech sooner and more reliably.
 *
 * Runs on the main thread off the mic worklet's frames (one ~0.3 ms inference per
 * window). Assets are local (public/vad/), so it works offline.
 * Model I/O (v5/v6): input [1, 64+512] @16 kHz (64 samples of the previous window
 * as context), state [2,1,128], sr int64 → output [1,1], stateN.
 */
import type * as Ort from "onnxruntime-web";

const WINDOW = 512;
const CONTEXT = 64;
// Absolute: ort resolves a relative wasmPaths against its own chunk (assets/), not the page.
const BASE = new URL(import.meta.env.BASE_URL + "vad/", location.href).href;

let ortP: Promise<typeof Ort> | null = null;
let sessionP: Promise<Ort.InferenceSession> | null = null;

async function session() {
  ortP ??= import("onnxruntime-web/wasm").then((ort) => {
    ort.env.wasm.wasmPaths = BASE;
    ort.env.wasm.numThreads = 1; // threads need cross-origin isolation; one is plenty here
    ort.env.logLevel = "error";
    return ort as unknown as typeof Ort;
  });
  const ort = await ortP;
  sessionP ??= ort.InferenceSession.create(BASE + "silero_vad_v6.onnx", { executionProviders: ["wasm"] });
  sessionP.catch(() => (sessionP = null));
  return { ort, s: await sessionP };
}

/** Load the model early (first mic start would otherwise use the energy detector briefly). */
export function preloadSilero(): Promise<boolean> {
  return session().then(
    () => true,
    (e) => {
      console.warn("[vad] Silero unavailable, using the energy detector", e);
      return false;
    },
  );
}

/**
 * One stream's detector: push mic PCM at any sample rate, get a speech probability
 * per 32 ms window via `onProb`. Inference is serialized (the model is stateful).
 */
export class SileroStream {
  ready = false;
  failed = false;
  /** Latest probability, 0–1. */
  prob = 0;
  private ort: typeof Ort | null = null;
  private s: Ort.InferenceSession | null = null;
  private state: Ort.Tensor | null = null;
  private sr: Ort.Tensor | null = null;
  private ctx = new Float32Array(CONTEXT);
  private win = new Float32Array(WINDOW);
  private n = 0;
  private pos = 0; // fractional read position for resampling
  private acc = 0;
  private accN = 0;
  private queue: Float32Array[] = [];
  private busy = false;
  private closed = false;

  constructor(private inRate: number, private onProb: (p: number) => void) {
    session().then(
      ({ ort, s }) => {
        if (this.closed) return;
        this.ort = ort;
        this.s = s;
        this.state = new ort.Tensor("float32", new Float32Array(2 * 128), [2, 1, 128]);
        this.sr = new ort.Tensor("int64", BigInt64Array.from([16000n]), []);
        this.ready = true;
      },
      () => (this.failed = true),
    );
  }

  /** Mic frame in (any rate) → 16 kHz windows of 512 → model. */
  push(pcm: Float32Array) {
    if (!this.ready || this.closed) return;
    const step = this.inRate / 16000;
    // Box-filter decimation: average the input samples each 16 kHz sample covers.
    for (let i = 0; i < pcm.length; i++) {
      this.acc += pcm[i];
      this.accN++;
      this.pos += 1;
      if (this.pos >= step) {
        this.pos -= step;
        this.win[this.n++] = this.acc / this.accN;
        this.acc = 0;
        this.accN = 0;
        if (this.n === WINDOW) {
          this.queue.push(this.win);
          this.win = new Float32Array(WINDOW);
          this.n = 0;
        }
      }
    }
    void this.drain();
  }

  private async drain() {
    if (this.busy || !this.s || !this.ort) return;
    this.busy = true;
    try {
      // Fell behind (stalled tab)? Skip to the newest windows; old audio is moot for detection.
      if (this.queue.length > 8) this.queue.splice(0, this.queue.length - 2);
      while (this.queue.length && !this.closed) {
        const w = this.queue.shift()!;
        const x = new Float32Array(CONTEXT + WINDOW);
        x.set(this.ctx, 0);
        x.set(w, CONTEXT);
        this.ctx = w.slice(WINDOW - CONTEXT);
        const out = await this.s.run({ input: new this.ort.Tensor("float32", x, [1, CONTEXT + WINDOW]), state: this.state!, sr: this.sr! });
        this.state = out["stateN"] as Ort.Tensor;
        this.prob = Number((out["output"] as Ort.Tensor).data[0]);
        if (!this.closed) this.onProb(this.prob);
      }
    } catch (e) {
      console.warn("[vad] Silero inference failed, using the energy detector", e);
      this.failed = true;
      this.ready = false;
    } finally {
      this.busy = false;
    }
  }

  close() {
    this.closed = true;
    this.queue = [];
  }
}

/** Sensitivity 0–100 → speech-probability trigger (60 → 0.52; 35 while Tony talks → 0.66). */
export function sileroThresholds(sensitivity: number) {
  const s = Math.max(0, Math.min(100, sensitivity)) / 100;
  const on = 0.85 - s * 0.55;
  return { on, off: Math.max(0.15, on - 0.17) };
}
