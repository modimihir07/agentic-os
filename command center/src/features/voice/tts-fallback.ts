import type { SpeakOpts, TtsEngine } from "./tts-types";

/** Primary TTS with automatic fallback to the system voice if Kokoro/ElevenLabs is
 * down. The fallback is per CALL, not a permanent switch: a transient failure (one
 * offline request, a quota blip) no longer strands the rest of the session on the
 * system voice — the next call tries the primary engine again. */
export class FallbackTts implements TtsEngine {
  readonly supported: boolean;
  constructor(private primary: TtsEngine, private backup: TtsEngine) {
    this.supported = primary.supported || backup.supported;
  }
  get name() {
    return this.primary.supported ? this.primary.name : this.backup.name;
  }
  async speak(text: string, opts?: SpeakOpts) {
    if (this.primary.supported) {
      try {
        return await this.primary.speak(text, opts);
      } catch (e) {
        // A cue's voice that the current engine doesn't have: retry without it
        // (still the primary engine) before giving up on this one call.
        if (opts?.voice) {
          try {
            return await this.primary.speak(text, opts.agent ? { agent: opts.agent } : undefined);
          } catch {
            /* engine really is down — fall through to the backup for this call */
          }
        }
        console.warn("[tts] primary failed for this utterance, using system voice", e);
      }
    }
    return this.backup.speak(text);
  }
  prefetch(text: string, opts?: SpeakOpts) {
    if (this.primary.supported) this.primary.prefetch?.(text, opts);
  }
  cancel() {
    this.primary.cancel();
    this.backup.cancel();
  }
  duck(on: boolean) {
    this.primary.duck?.(on);
    this.backup.duck?.(on);
  }
  pause() {
    this.primary.pause?.();
    this.backup.pause?.();
  }
  resume() {
    this.primary.resume?.();
    this.backup.resume?.();
  }
}
