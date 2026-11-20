import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (name: string) => {
    if (name === "dev_task_delete") throw new Error("no such task");
    return { ok: true };
  }),
}));

import { IPC_RING_CAP, ipcSummary, pushRing, recordIpc, useIpcRing, type IpcCall } from "./ipc-ring";

describe("pushRing", () => {
  it("appends and drops the oldest past the cap", () => {
    let r: number[] = [];
    for (let i = 0; i < 7; i++) r = pushRing(r, i, 5);
    expect(r).toEqual([2, 3, 4, 5, 6]);
    expect(pushRing([1], 2, 5)).toEqual([1, 2]);
  });
});

describe("useIpcRing", () => {
  beforeEach(() => useIpcRing.getState().clear());

  it("keeps the last 200 invocations", () => {
    for (let i = 0; i < IPC_RING_CAP + 10; i++) recordIpc(`c${i}`, i, true, i);
    const calls = useIpcRing.getState().calls;
    expect(calls).toHaveLength(IPC_RING_CAP);
    expect(calls[0].name).toBe("c10");
  });

  it("summarises per command, slowest median first", () => {
    const calls: IpcCall[] = [
      { name: "tts_synthesize", ms: 400, ok: true, at: 1 },
      { name: "tts_synthesize", ms: 600, ok: false, at: 2 },
      { name: "system_stats", ms: 30, ok: true, at: 3 },
    ];
    expect(ipcSummary(calls)).toEqual([
      { name: "tts_synthesize", count: 2, medianMs: 500, maxMs: 600, failures: 1 },
      { name: "system_stats", count: 1, medianMs: 30, maxMs: 30, failures: 0 },
    ]);
  });
});

describe("cmd() records names and timings, never arguments", () => {
  const g = globalThis as unknown as { window?: unknown };
  const had = "window" in g;
  g.window = { __TAURI_INTERNALS__: {} };
  afterAll(() => {
    if (!had) delete g.window;
  });

  it("records ok and failed invocations", async () => {
    useIpcRing.getState().clear();
    const { cmd } = await import("./platform");
    await cmd("dev_task_add", { title: "token=abcdef123456 leaked?" });
    await expect(cmd("dev_task_delete", { id: "x" })).rejects.toThrow("no such task");
    await Promise.resolve();
    const calls = useIpcRing.getState().calls;
    expect(calls.map((c) => [c.name, c.ok])).toEqual([
      ["dev_task_add", true],
      ["dev_task_delete", false],
    ]);
    for (const c of calls) expect(Object.keys(c).sort()).toEqual(["at", "ms", "name", "ok"]);
    expect(JSON.stringify(calls)).not.toContain("abcdef123456");
  });
});
