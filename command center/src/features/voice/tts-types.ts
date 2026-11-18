/**
 * TTS engine contract, split out from `engines.ts` so it can be imported
 * (type-only or otherwise) without pulling in `engines.ts`'s browser-only
 * code — notably `silero.ts`, which touches `location` at module-eval time
 * and crashes under Vitest's node environment (same reason Part 5 split
 * `listen-profiles.ts`/`vad-rules.ts` out of `capture.ts`).
 */

/** `voice` overrides the configured voice (cue widgets); engines without voices ignore it.
 * `agent` (Part 3) names who's speaking ("general" = Tony) so a per-agent voice-roster
 * entry can be used server-side when `voice` itself isn't given. `previousText` (Part 6
 * §2) is the sentence spoken right before this one in the same reply — engines that
 * synthesize sentence-by-sentence pass it per-call for ElevenLabs prosody continuity;
 * engines/providers that don't support it simply ignore it. */
export interface SpeakOpts {
  voice?: string;
  agent?: string;
  previousText?: string;
}

export interface TtsEngine {
  readonly name: string;
  readonly supported: boolean;
  speak(text: string, opts?: SpeakOpts): Promise<void>;
  /** Start synthesizing now so a later speak() of the same text plays without a gap. */
  prefetch?(text: string, opts?: SpeakOpts): void;
  cancel(): void;
}
