// Copies each 128-frame mono block of mic audio to the main thread.
// Loaded from /worklets so the strict CSP (script-src 'self') allows it.
class PcmCapture extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor("pcm-capture", PcmCapture);
