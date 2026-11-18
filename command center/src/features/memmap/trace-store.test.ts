import { beforeEach, describe, expect, it } from "vitest";
import type { PipelineStepEvent, TraceStep } from "@/lib/platform";
import { appendSteps, groupTraces, HOPS, hopStats, normalizeStep, pipelineToStep, recordHop, scrubText, stepsSince, TRACE_CAP, useTrace, zoneOf } from "./trace-store";

const step = (traceId: string, seq: number, hop: TraceStep["hop"], at: number, ms = 10, ok = true): TraceStep => ({ traceId, seq, hop, zone: zoneOf(hop), label: hop, ok, ms, at });

describe("zone mapping", () => {
  it("follows the plan: cockpit / engine / ecu / cargo / exhaust", () => {
    expect(Object.fromEntries(HOPS.map((h) => [h, zoneOf(h)]))).toEqual({
      input: "cockpit",
      vad: "cockpit",
      stt: "cockpit",
      router: "engine",
      rules: "ecu",
      memory: "cargo",
      model: "engine",
      tool: "exhaust",
      tts: "cockpit",
      ui: "cockpit",
    });
  });

  it("derives the zone from the hop, whatever the payload claims", () => {
    expect(normalizeStep({ traceId: "t", seq: 0, hop: "tool", zone: "cockpit", label: "x", ok: true, ms: 1, at: 1 })?.zone).toBe("exhaust");
  });
});

describe("normalizeStep", () => {
  it("drops payloads without a trace id or with an unknown hop", () => {
    expect(normalizeStep(null)).toBeNull();
    expect(normalizeStep({ hop: "tool" })).toBeNull();
    expect(normalizeStep({ traceId: "t", hop: "warp" })).toBeNull();
  });

  it("scrubs and caps error text, clamps numbers and drops a bad tps", () => {
    const s = normalizeStep({ traceId: "t", seq: -4, hop: "model", label: "lmstudio", ok: false, ms: -3, error: "401 Bearer abcdefghijklmnopqrstu " + "x".repeat(400), at: 5, tps: Number.NaN })!;
    expect(s.seq).toBe(0);
    expect(s.ms).toBe(0);
    expect(s.error).not.toContain("abcdefghijklmnopqrstu");
    expect(s.error!.length).toBeLessThanOrEqual(201);
    expect(s.tps).toBeUndefined();
    expect(normalizeStep({ traceId: "t", hop: "model", ok: true, ms: 1, at: 1, tps: 41.26 })!.tps).toBe(41.3);
  });

  it("scrubText removes key shapes and assignments but keeps prose", () => {
    expect(scrubText("token=abcdef123456 failed")).toBe("token=[redacted] failed");
    expect(scrubText("sk-ant-api03-abcdefghijklmnop")).toBe("[redacted]");
    expect(scrubText("token rejected by server")).toBe("token rejected by server");
  });
});

describe("ring buffer", () => {
  it("keeps only the newest 500 steps", () => {
    let ring: TraceStep[] = [];
    for (let i = 0; i < TRACE_CAP + 25; i++) ring = appendSteps(ring, [step("t", i, "tool", i)]);
    expect(ring).toHaveLength(TRACE_CAP);
    expect(ring[0].seq).toBe(25);
    expect(ring[ring.length - 1].seq).toBe(TRACE_CAP + 24);
  });

  it("counts steps that arrived after a pause even once the ring is full", () => {
    let ring: TraceStep[] = [];
    for (let i = 0; i < TRACE_CAP; i++) ring = appendSteps(ring, [step("t", i, "tool", i)]);
    const frozen = ring;
    for (let i = 0; i < 7; i++) ring = appendSteps(ring, [step("t", TRACE_CAP + i, "tool", TRACE_CAP + i)]);
    expect(ring).toHaveLength(frozen.length);
    expect(stepsSince(ring, frozen)).toBe(7);
    expect(stepsSince(ring, ring)).toBe(0);
    expect(stepsSince(ring, [])).toBe(ring.length);
    // The paused snapshot's last step was evicted: everything left is new.
    expect(stepsSince(ring, [step("gone", 0, "tool", 0)])).toBe(ring.length);
  });
});

describe("groupTraces", () => {
  it("groups by trace id, orders steps by time then seq, newest trace first", () => {
    const steps = [step("a", 1, "router", 100), step("b", 0, "input", 150), step("a", 0, "input", 100), step("a", 2, "tool", 300, 120, false), step("b", 1, "model", 400, 250)];
    const [b, a] = groupTraces(steps);
    expect(b.traceId).toBe("b");
    expect(a.steps.map((s) => s.hop)).toEqual(["input", "router", "tool"]);
    expect(a.ok).toBe(false);
    expect(b.ok).toBe(true);
    expect(a.path).toEqual(["cockpit", "engine", "exhaust"]);
    expect(a.slowest?.hop).toBe("tool");
    // From the first step's start (at - ms) to the last step's end.
    expect(a.startedAt).toBe(90);
    expect(a.ms).toBe(210);
  });

  it("collapses repeats of a zone in the pulse path", () => {
    const [g] = groupTraces([step("t", 0, "input", 1), step("t", 1, "vad", 2), step("t", 2, "router", 3), step("t", 3, "model", 4), step("t", 4, "rules", 5), step("t", 5, "ui", 6)]);
    expect(g.path).toEqual(["cockpit", "engine", "ecu", "cockpit"]);
  });
});

describe("hopStats", () => {
  it("reports the last and median ms per hop", () => {
    const st = hopStats([step("a", 0, "stt", 1, 300), step("b", 0, "stt", 2, 100), step("c", 0, "stt", 3, 200, false), step("c", 1, "tts", 4, 50)]);
    expect(st.stt).toEqual({ lastMs: 200, medianMs: 200, count: 3, lastOk: false });
    expect(st.tts?.medianMs).toBe(50);
    expect(st.model).toBeUndefined();
  });
});

describe("pipelineToStep", () => {
  const ev = (over: Partial<PipelineStepEvent>): PipelineStepEvent =>
    ({ pipelineId: "p1", ideaId: "i1", cardId: null, stage: "spec", pct: 20, thread: "prompter", kind: "delegate", from: "os", to: "prompter", text: "SECRET USER PROMPT", ok: true, ms: 40, ...over }) as PipelineStepEvent;

  it("maps kinds to hops and never copies the step text on success", () => {
    const d = pipelineToStep(ev({}), 0, 10)!;
    expect(d).toMatchObject({ traceId: "pipeline:p1", hop: "router", zone: "engine", label: "spec · os → prompter", ok: true, ms: 40, at: 10 });
    expect(JSON.stringify(d)).not.toContain("SECRET USER PROMPT");
    expect(pipelineToStep(ev({ kind: "reply", from: "librarian", to: "os" }), 1)!.hop).toBe("memory");
    expect(pipelineToStep(ev({ kind: "reply", from: "coder", to: "os" }), 1)!.hop).toBe("model");
    expect(pipelineToStep(ev({ kind: "tool", to: "fs.read" }), 1)!.label).toBe("spec · fs.read");
    expect(pipelineToStep(ev({ kind: "verify", ok: false, text: "issues quoting the payload" }), 1)).toMatchObject({ hop: "rules", error: "verifier flagged issues" });
    expect(pipelineToStep(ev({ stage: "done", kind: "reply" }), 1)!.hop).toBe("ui");
  });

  it("keeps a failure's error text", () => {
    expect(pipelineToStep(ev({ kind: "error", from: "coder", to: "os", ok: false, text: "Coder agent failed: HTTP 500" }), 2)).toMatchObject({ hop: "model", ok: false, error: "Coder agent failed: HTTP 500" });
  });
});

describe("recordHop", () => {
  beforeEach(() => useTrace.getState().clear());

  it("numbers a trace's client hops and lands them in the store", () => {
    recordHop("turn-1", "input", "typed line", { at: 1 });
    recordHop("turn-1", "ui", "reply shown", { ms: 900, at: 2 });
    recordHop("", "ui", "ignored");
    const steps = useTrace.getState().steps;
    expect(steps.map((s) => [s.traceId, s.seq, s.hop, s.zone])).toEqual([
      ["turn-1", 0, "input", "cockpit"],
      ["turn-1", 1, "ui", "cockpit"],
    ]);
  });
});
