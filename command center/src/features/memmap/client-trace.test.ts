import { beforeEach, describe, expect, it } from "vitest";
import { clientTrace } from "./client-trace";
import { groupTraces, useTrace } from "./trace-store";

beforeEach(() => {
  clientTrace.reset();
  useTrace.getState().clear();
});

describe("clientTrace", () => {
  it("puts a voice turn's VAD, STT, input, TTS and UI hops in one trace", () => {
    clientTrace.phase("waiting", 1000);
    clientTrace.phase("speech", 1000);
    clientTrace.phase("transcribing", 2500);
    clientTrace.sttFinal("Whisper", true, 2900);
    const id = clientTrace.begin("voice", 2950);
    expect(clientTrace.id).toBe(id);
    clientTrace.tts(id, "ElevenLabs", 1200, true);
    clientTrace.ui(id, "reply shown", true, undefined, 4950);
    const [g] = groupTraces(useTrace.getState().steps);
    expect(g.traceId).toBe(id);
    expect(g.steps.map((s) => [s.hop, s.ms])).toEqual([
      ["vad", 1500],
      ["stt", 400],
      ["input", 0],
      ["ui", 2000],
      ["tts", 1200],
    ]);
    expect(g.steps.every((s) => s.zone === "cockpit")).toBe(true);
  });

  it("gives a typed line its own trace, even with a voice listen pending", () => {
    clientTrace.phase("speech", 10);
    const typed = clientTrace.begin("text", 20);
    expect(groupTraces(useTrace.getState().steps).map((g) => g.traceId)).toEqual([typed]);
  });

  it("does not adopt a stale or silent listen", () => {
    clientTrace.phase("speech", 0);
    clientTrace.phase("transcribing", 100);
    clientTrace.sttFinal("Whisper", false, 200);
    const a = clientTrace.begin("voice", 300);
    const silent = useTrace.getState().steps.find((s) => s.hop === "stt")!;
    expect(silent.label).toBe("Whisper · no speech");
    expect(a).not.toBe(silent.traceId);
    clientTrace.phase("speech", 1000);
    const b = clientTrace.begin("voice", 1000 + 10 * 60_000);
    expect(useTrace.getState().steps.filter((s) => s.traceId === b).map((s) => s.hop)).toEqual(["input"]);
  });

  it("records an STT failure and starts fresh on the next utterance", () => {
    clientTrace.phase("speech", 0);
    clientTrace.phase("transcribing", 50);
    clientTrace.sttError("Whisper", "Whisper unreachable", 80);
    const failed = useTrace.getState().steps.find((s) => s.hop === "stt")!;
    expect(failed).toMatchObject({ ok: false, error: "Whisper unreachable", ms: 30 });
    clientTrace.phase("speech", 200);
    clientTrace.phase("transcribing", 300);
    const vads = useTrace.getState().steps.filter((s) => s.hop === "vad");
    expect(vads).toHaveLength(2);
    expect(vads[1].traceId).not.toBe(failed.traceId);
  });

  it("skips TTS / UI hops without a trace", () => {
    clientTrace.tts(undefined, "Kokoro", 10, true);
    clientTrace.ui(null, "reply shown");
    expect(useTrace.getState().steps).toHaveLength(0);
  });
});
