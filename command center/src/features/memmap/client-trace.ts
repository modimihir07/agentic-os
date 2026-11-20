import { newTraceId, recordHop } from "./trace-store";

/**
 * The webview's own hops of a turn (System Map, plan §2): input, VAD (speech start → end),
 * STT (end of speech → transcript), TTS (each spoken line) and UI (answer or error on screen).
 * voice-controller calls these at the points it already handles; nothing here changes what
 * the voice pipeline does. Labels name engines and stages only — never what was said.
 *
 * A voice listen opens a pending trace at the first speech; the turn it produces adopts that
 * trace (so VAD/STT and the Rust hops line up), and `os_turn` is called with the same id.
 */

/** A voice line that produced no turn this long ago is not adopted by the next turn. */
const ADOPT_WINDOW_MS = 120_000;

interface PendingListen {
  id: string;
  speechAt: number;
  transcribingAt?: number;
}

let pending: PendingListen | null = null;
let current: string | null = null;
/** When each recent turn started (for the UI hop's end-to-end ms). */
const starts = new Map<string, number>();

export const clientTrace = {
  /** An STT engine's phase change. */
  phase(p: string, now = Date.now()) {
    if (p === "speech") {
      // A fresh utterance (barge-in / follow-up listens reuse the same handlers).
      if (!pending || pending.transcribingAt !== undefined) pending = { id: newTraceId(), speechAt: now };
    } else if (p === "transcribing" && pending && pending.transcribingAt === undefined) {
      pending.transcribingAt = now;
      recordHop(pending.id, "vad", "speech start → end", { ms: now - pending.speechAt, at: now });
    }
  },

  /** The transcript arrived (`hadText` false = silence / nothing usable). */
  sttFinal(engine: string, hadText: boolean, now = Date.now()) {
    if (!pending) return;
    if (pending.transcribingAt !== undefined) recordHop(pending.id, "stt", hadText ? engine : `${engine} · no speech`, { ms: now - pending.transcribingAt, at: now });
    if (!hadText) pending = null;
  },

  /** Transcription (or the mic) failed. */
  sttError(engine: string, error: string, now = Date.now()) {
    if (!pending) return;
    recordHop(pending.id, "stt", engine, { ok: false, ms: pending.transcribingAt !== undefined ? now - pending.transcribingAt : 0, error, at: now });
    pending = null;
  },

  /** A turn starts (`handleInput`). Returns its trace id: the voice listen's when the line came from one. */
  begin(channel: "voice" | "text", now = Date.now()): string {
    const adopt = channel === "voice" && pending && now - pending.speechAt < ADOPT_WINDOW_MS ? pending.id : null;
    const id = adopt ?? newTraceId();
    pending = null;
    current = id;
    starts.set(id, now);
    if (starts.size > 50) starts.delete(starts.keys().next().value as string);
    recordHop(id, "input", channel === "voice" ? "voice line" : "typed line", { at: now });
    return id;
  },

  /** The trace of the turn in progress, if any. */
  get id(): string | null {
    return current;
  },

  /** One spoken line of `traceId` finished (or failed): synthesis + playback wall time. */
  tts(traceId: string | undefined, engine: string, ms: number, ok: boolean, error?: string) {
    if (traceId) recordHop(traceId, "tts", engine, { ms, ok, error });
  },

  /** `traceId`'s answer (or error) is on screen; `ms` = since that turn's input. */
  ui(traceId: string | null | undefined, label: string, ok = true, error?: string, now = Date.now()) {
    if (!traceId) return;
    const start = starts.get(traceId);
    recordHop(traceId, "ui", label, { ms: start === undefined ? 0 : now - start, ok, error, at: now });
  },

  /** Tests only. */
  reset() {
    pending = null;
    current = null;
    starts.clear();
  },
};
