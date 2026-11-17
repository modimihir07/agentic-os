// Mic capture on the audio thread: batches ~21 ms of mono PCM and its RMS level
// and posts them to the main thread. Voice-activity detection runs off these
// messages — NOT requestAnimationFrame, which Chromium pauses or throttles to
// ~1 Hz when the window is in the background (the cause of 30–60 s delays).
// Loaded from /worklets so the strict CSP (script-src 'self') allows it.
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(1024);
    this.n = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.buf[this.n++] = ch[i];
      if (this.n === this.buf.length) {
        let sum = 0;
        for (let j = 0; j < this.n; j++) sum += this.buf[j] * this.buf[j];
        const pcm = this.buf.slice(0, this.n);
        this.port.postMessage({ pcm, rms: Math.sqrt(sum / this.n) }, [pcm.buffer]);
        this.n = 0;
      }
    }
    return true;
  }
}
registerProcessor("pcm-capture", PcmCapture);
