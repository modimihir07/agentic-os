import { describe, expect, it } from "vitest";
import type { DevTask, DevTaskStatus, OsKeyStatus, OsSecret, SnapAgent, SnapBus, SnapLoop, SnapStore, SystemSnapshot, TraceStep } from "@/lib/platform";
import {
  agentTag,
  apiKeyPresence,
  applySlot,
  briefButtonState,
  busHeaderFix,
  busNeedsFix,
  busText,
  busTone,
  busWhy,
  daemonState,
  dictVoiceState,
  fixTitle,
  futureRuns,
  fmtAgo,
  fmtBytes,
  fmtDue,
  fmtMb,
  fmtMs,
  fmtUptime,
  frameDue,
  gatewayRtt,
  hardwareChip,
  latestTps,
  slowestHop,
  nextPriority,
  nextStatus,
  openCounts,
  osSwitchBlock,
  pct,
  roleActive,
  sortBus,
  sortTasks,
  splitNote,
  storeRows,
  storeShares,
  tonyMicBusy,
  upsertTask,
  visibleTasks,
} from "./format";

const task = (o: Partial<DevTask> & { id: string }): DevTask => ({
  title: o.id,
  category: "backend",
  priority: 2,
  status: "Pending",
  contextSnapshot: {},
  kind: "task",
  body: "",
  source: "typed",
  createdAt: 0,
  updatedAt: 0,
  ...o,
});

const agent = (o: Partial<SnapAgent> & { role: string; slug: string }): SnapAgent => ({
  label: o.role,
  found: true,
  threads: 0,
  chatProvider: null,
  chatModel: null,
  agentProvider: null,
  agentModel: null,
  active: false,
  ...o,
});

const bus = (o: Partial<SnapBus> & { id: string; status: SnapBus["status"] }): SnapBus => ({ name: o.id, transport: "stdio", error: null, tools: null, ...o });

describe("formatters", () => {
  it("fmtUptime picks the two largest units", () => {
    expect(fmtUptime(45)).toBe("45s");
    expect(fmtUptime(12 * 60 + 5)).toBe("12m 05s");
    expect(fmtUptime(4 * 3600 + 12 * 60 + 59)).toBe("4h 12m");
    expect(fmtUptime(3 * 86_400 + 4 * 3600)).toBe("3d 04h");
    expect(fmtUptime(null)).toBeNull();
    expect(fmtUptime(-1)).toBeNull();
    expect(fmtUptime(Number.NaN)).toBeNull();
  });

  it("fmtMs switches to seconds", () => {
    expect(fmtMs(0)).toBe("0 ms");
    expect(fmtMs(840.4)).toBe("840 ms");
    expect(fmtMs(1234)).toBe("1.2 s");
    expect(fmtMs(12_400)).toBe("12 s");
    expect(fmtMs(undefined)).toBeNull();
  });

  it("fmtMb / fmtBytes", () => {
    expect(fmtMb(512)).toBe("512 MB");
    expect(fmtMb(12_288)).toBe("12.0 GB");
    expect(fmtMb(null)).toBeNull();
    expect(fmtBytes(96)).toBe("96 B");
    expect(fmtBytes(2048)).toBe("2 KB");
    expect(fmtBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(fmtBytes(3 * 1024 ** 3)).toBe("3.00 GB");
    expect(fmtBytes(undefined)).toBeNull();
  });

  it("pct is null without a usable total and clamps to 0–100", () => {
    expect(pct(6, 12)).toBe(50);
    expect(pct(20, 10)).toBe(100);
    expect(pct(1, 0)).toBeNull();
    expect(pct(null, 10)).toBeNull();
    expect(pct(1, undefined)).toBeNull();
  });

  it("fmtAgo", () => {
    expect(fmtAgo(1000, 3000)).toBe("now");
    expect(fmtAgo(0, 30_000)).toBe("30s ago");
    expect(fmtAgo(0, 5 * 60_000)).toBe("5m ago");
    expect(fmtAgo(0, 3 * 3_600_000)).toBe("3h ago");
    expect(fmtAgo(0, 2 * 86_400_000)).toBe("2d ago");
    expect(fmtAgo(null, 0)).toBeNull();
  });
});

describe("agents", () => {
  it("roleActive mirrors Rust role_active", () => {
    const labels = ["anythingllm · coder (streaming)", "lmstudio · Tony"];
    expect(roleActive(labels, "coder", false)).toBe(true);
    expect(roleActive(labels, "code", false)).toBe(false);
    expect(roleActive(labels, "designer", false)).toBe(false);
    expect(roleActive(labels, "my-workspace", true)).toBe(true);
    expect(roleActive(["anythingllm · booking"], "my-workspace", true)).toBe(false);
    expect(roleActive(["anythingllm · my-workspace"], "my-workspace", true)).toBe(true);
    expect(roleActive([], "coder", false)).toBe(false);
    expect(roleActive(["no separator"], "", true)).toBe(false);
  });

  it("applySlot updates active flags and keeps the array when nothing changed", () => {
    const agents = [agent({ role: "general", slug: "my-workspace" }), agent({ role: "coder", slug: "coder" })];
    const next = applySlot(agents, ["anythingllm · coder"]);
    expect(next.map((a) => a.active)).toEqual([false, true]);
    expect(next[0]).toBe(agents[0]);
    expect(applySlot(next, ["anythingllm · coder"])).toBe(next);
    expect(applySlot(next, ["lmstudio · Tony"]).map((a) => a.active)).toEqual([true, false]);
  });

  it("agentTag", () => {
    expect(agentTag(agent({ role: "coder", slug: "coder", active: true }))).toEqual({ text: "Active", tone: "ok" });
    expect(agentTag(agent({ role: "coder", slug: "coder" }))).toEqual({ text: "Idle", tone: "idle" });
    expect(agentTag(agent({ role: "coder", slug: "coder", found: false }))).toEqual({ text: "Missing", tone: "down" });
    expect(agentTag(agent({ role: "coder", slug: "coder", found: null })).text).toBe("Idle");
  });
});

describe("bus", () => {
  it("maps statuses to mockup words and tones", () => {
    expect(busText("ok")).toBe("Connected");
    expect(busText("needs_token")).toBe("Awaiting token");
    expect(busText("starting")).toBe("Starting…");
    expect(busText("auth_failed")).toBe("Auth Failed");
    expect(busText("unknown")).toBe("—");
    expect(busText("weird")).toBe("weird");
    expect(busTone("ok")).toBe("ok");
    // Muted, not a failure: no call is made until a token is added.
    expect(busTone("needs_token")).toBe("idle");
    expect(busTone("starting")).toBe("warn");
    expect(busTone("error")).toBe("down");
    expect(busTone("off")).toBe("idle");
    expect(busNeedsFix("needs_token")).toBe(true);
    expect(busNeedsFix("ok")).toBe(false);
    expect(busNeedsFix("unknown")).toBe(false);
  });

  it("busWhy explains with error text, never more", () => {
    expect(busWhy(bus({ id: "github", status: "auth_failed", error: "GitHub: token expired or invalid (HTTP 401)" }))).toContain("HTTP 401");
    expect(busWhy(bus({ id: "x", status: "unknown" }))).toMatch(/deep scan/);
    expect(busWhy(bus({ id: "x", status: "ok", tools: 7 }))).toBe("7 tools listed");
    expect(busWhy(bus({ id: "x", status: "ok", lastOk: false, lastError: "timed out" }))).toBe("timed out");
  });

  it("sortBus puts problems first", () => {
    const sorted = sortBus([bus({ id: "b", status: "ok" }), bus({ id: "a", status: "off" }), bus({ id: "c", status: "needs_token" }), bus({ id: "d", status: "auth_failed" })]);
    expect(sorted.map((b) => b.id)).toEqual(["d", "c", "b", "a"]);
  });
});

describe("stores & daemon", () => {
  const store = (o: Partial<SnapStore> & { id: SnapStore["id"] }): SnapStore => ({ label: o.id, kind: "sqlite", exists: true, health: "ok", tables: [], metrics: {}, ...o });

  it("storeShares splits known bytes; unknown sizes are null", () => {
    const m = storeShares([store({ id: "cc", bytes: 300 }), store({ id: "memory", bytes: 100 }), store({ id: "knowledge-graph", bytes: null })]);
    expect(m.get("cc")).toBe(75);
    expect(m.get("memory")).toBe(25);
    expect(m.get("knowledge-graph")).toBeNull();
    expect(storeShares([store({ id: "cc", bytes: 0 })]).get("cc")).toBeNull();
  });

  it("storeRows sums counted tables only", () => {
    expect(storeRows(store({ id: "cc", tables: [{ name: "a", rows: 2 }, { name: "b", rows: null }, { name: "c", rows: 3 }] }))).toBe(5);
    expect(storeRows(store({ id: "cc", tables: [{ name: "a", rows: null }] }))).toBeNull();
    expect(storeRows(store({ id: "cc" }))).toBeNull();
  });

  it("daemonState counts loops that ran on schedule", () => {
    const loop = (o: Partial<SnapLoop>): SnapLoop => ({ id: "inbox", label: "x", intervalSecs: 3, source: "s", lastRun: null, lastOk: null, detail: null, runs: 0, overdue: false, ...o });
    expect(daemonState([loop({}), loop({})])).toBeNull();
    expect(daemonState([loop({ lastRun: 1, lastOk: true }), loop({ lastRun: 1, overdue: true }), loop({ lastRun: 1, lastOk: false }), loop({})])).toEqual({ healthy: 1, ran: 3, total: 4 });
  });
});

describe("top bar", () => {
  const snap = (services: SystemSnapshot["services"], host: Partial<SystemSnapshot["host"]> = {}) =>
    ({ services, host: { cpuBrand: null, cpuThreads: 16, ...host } }) as unknown as SystemSnapshot;

  it("gatewayRtt says why it has no number", () => {
    expect(gatewayRtt(null)).toEqual({ why: "No system snapshot yet" });
    expect(gatewayRtt(snap([]))).toEqual({ why: "The gateway isn't configured" });
    expect(gatewayRtt(snap([{ id: "gateway", label: "g", kind: "k", up: false, latencyMs: 0, detail: "refused", port: 8080 }]))).toEqual({ why: "Gateway down: refused" });
    expect(gatewayRtt(snap([{ id: "gateway", label: "g", kind: "k", up: true, latencyMs: 14, detail: "200", port: 8080 }]))).toEqual({ ms: 14 });
  });

  it("hardwareChip prefers the GPU and trims vendor noise", () => {
    expect(hardwareChip(null)).toBeNull();
    expect(hardwareChip(snap([], { gpu: { name: "NVIDIA GeForce RTX 3060", utilPct: 0, vramUsedMb: 0, vramTotalMb: 12288 } }))).toBe("RTX 3060");
    expect(hardwareChip(snap([], { gpu: null, cpuBrand: "AMD Ryzen 7 3800X 8-Core Processor" }))).toBe("Ryzen 7 3800X");
    expect(hardwareChip(snap([], { gpu: null }))).toBeNull();
  });
});

describe("dev task queue", () => {
  it("status pill cycles Pending → Queued → In Progress → Done → Pending", () => {
    const seen: DevTaskStatus[] = ["Pending"];
    for (let i = 0; i < 4; i++) seen.push(nextStatus(seen[seen.length - 1]));
    expect(seen).toEqual(["Pending", "Queued", "In Progress", "Done", "Pending"]);
  });

  it("priority cycles 0 → 1 → 2 → 3 → 0", () => {
    expect([nextPriority(0), nextPriority(1), nextPriority(2), nextPriority(3)]).toEqual([1, 2, 3, 0]);
  });

  it("sortTasks matches Rust's order", () => {
    const tasks = [
      task({ id: "done", status: "Done", priority: 0 }),
      task({ id: "queued", status: "Queued", priority: 0 }),
      task({ id: "pending-late", status: "Pending", priority: 1, createdAt: 9 }),
      task({ id: "pending-early", status: "Pending", priority: 1, createdAt: 1 }),
      task({ id: "pending-urgent", status: "Pending", priority: 0, createdAt: 99 }),
      task({ id: "wip", status: "In Progress", priority: 3 }),
    ];
    expect(sortTasks(tasks).map((t) => t.id)).toEqual(["wip", "pending-urgent", "pending-early", "pending-late", "queued", "done"]);
  });

  it("upsertTask replaces by id and re-sorts", () => {
    const list = [task({ id: "a" }), task({ id: "b", createdAt: 1 })];
    const next = upsertTask(list, task({ id: "b", status: "In Progress", createdAt: 1 }));
    expect(next.map((t) => `${t.id}:${t.status}`)).toEqual(["b:In Progress", "a:Pending"]);
    expect(upsertTask(next, task({ id: "c", status: "Done" }))).toHaveLength(3);
  });

  it("visibleTasks / openCounts honour the filter and Done", () => {
    const list = [task({ id: "1", category: "ui" }), task({ id: "2", category: "ui", status: "Done" }), task({ id: "3", category: "mcp" })];
    expect(visibleTasks(list, "all", false).map((t) => t.id)).toEqual(["1", "3"]);
    expect(visibleTasks(list, "ui", true).map((t) => t.id)).toEqual(["1", "2"]);
    expect(visibleTasks(list, "auth", true)).toEqual([]);
    expect(openCounts(list)).toEqual({ all: 2, mcp: 1, auth: 0, ui: 1, backend: 0, routing: 0 });
  });

  it("briefButtonState", () => {
    expect(briefButtonState({ desktop: false, exporting: false, open: 3 })).toMatchObject({ disabled: true, title: expect.stringMatching(/desktop/) });
    expect(briefButtonState({ desktop: true, exporting: true, open: 3 })).toMatchObject({ disabled: true, label: "Exporting…" });
    expect(briefButtonState({ desktop: true, exporting: false, open: 1 })).toMatchObject({ disabled: false, label: "Export Session Brief", title: expect.stringContaining("1 open task,") });
    expect(briefButtonState({ desktop: true, exporting: false, open: 0 }).title).toContain("no open tasks");
  });

  it("splitNote: first line is the title, the rest the body", () => {
    expect(splitNote("\n  Fix the bus card \nIt shows stale\nstatuses")).toEqual({ title: "Fix the bus card", body: "It shows stale\nstatuses" });
    expect(splitNote("   ")).toEqual({ title: "", body: "" });
    const long = `${"word ".repeat(60)}end`;
    const r = splitNote(long, 50);
    expect(r.title.length).toBeLessThanOrEqual(51);
    expect(r.title.endsWith("…")).toBe(true);
    expect(r.body).toBe(long);
  });

  it("fixTitle", () => {
    expect(fixTitle({ hop: "tool", label: "brave.search" })).toBe("Fix tool: brave.search");
    expect(fixTitle({ hop: "model", label: "" })).toBe("Fix model: failed step");
    expect(fixTitle({ hop: "tool", label: "x".repeat(400) })).toHaveLength(200);
  });
});

describe("trace & dictation", () => {
  const step = (o: Partial<TraceStep>): TraceStep => ({ traceId: "t", seq: 0, hop: "model", zone: "engine", label: "", ok: true, ms: 0, at: 0, ...o });

  it("latestTps takes the newest model step that measured it", () => {
    expect(latestTps([])).toBeNull();
    expect(latestTps([step({ tps: 30 }), step({ hop: "tool", zone: "exhaust" }), step({})])).toBe(30);
    expect(latestTps([step({ tps: 30 }), step({ tps: 42.5 })])).toBe(42.5);
  });

  it("slowestHop ignores the end-to-end ui hop and input markers", () => {
    const a = step({ hop: "model", ms: 900 });
    const b = step({ hop: "tool", zone: "exhaust", ms: 300 });
    expect(slowestHop([step({ hop: "input", zone: "cockpit", ms: 0 }), a, b, step({ hop: "ui", zone: "cockpit", ms: 1500 })])).toBe(a);
    expect(slowestHop([a, step({ hop: "ui", zone: "cockpit", ms: 1500 })])).toBeNull();
    expect(slowestHop([])).toBeNull();
  });

  it("dictation phases map onto toggleAction's voice states", () => {
    expect(dictVoiceState("idle")).toBe("idle");
    expect(dictVoiceState("waiting")).toBe("listening");
    expect(dictVoiceState("speech")).toBe("listening");
    expect(dictVoiceState("transcribing")).toBe("transcribing");
    expect(tonyMicBusy("listening")).toBe(true);
    expect(tonyMicBusy("transcribing")).toBe(true);
    expect(tonyMicBusy("speaking")).toBe(false);
    expect(tonyMicBusy("idle")).toBe(false);
  });
});

describe("future runs", () => {
  const loop = (o: Partial<SnapLoop>): SnapLoop => ({ id: "inbox", label: "Inbox drain", intervalSecs: 60, source: "s", lastRun: null, lastOk: null, detail: null, runs: 0, overdue: false, ...o });
  const snap = (routines: Partial<SystemSnapshot["routines"]>, slot: Partial<SystemSnapshot["slot"]> = {}) =>
    ({
      routines: { loops: [], schedulerJobs: [], schedulerNote: null, n8nConfigured: [], n8n: [], n8nNote: null, ...routines },
      slot: { active: [], queuedForeground: 0, queuedBackground: 0, capacity: 1, ...slot },
    }) as unknown as SystemSnapshot;
  const job = (o: Partial<NonNullable<SystemSnapshot["routines"]["schedulerJobs"]>[number]>) => ({ id: "j", name: "Job", skill: null, cron: null, enabled: true, lastRun: null, nextRun: null, ...o });
  const NOW = Date.parse("2026-11-18T12:00:00Z");

  it("is empty without a snapshot", () => {
    expect(futureRuns(null, NOW)).toEqual({ runs: [], notes: [] });
  });

  it("keeps enabled jobs with a next run, sorted by due time", () => {
    const { runs } = futureRuns(
      snap({
        schedulerJobs: [
          job({ id: "late", name: "Standup", nextRun: "2026-11-18T13:00:00Z", cron: "0 13 * * *" }),
          job({ id: "off", enabled: false, nextRun: "2026-11-18T12:01:00Z" }),
          job({ id: "none", nextRun: null }),
          job({ id: "soon", name: "Heartbeat", nextRun: "2026-11-18T12:05:00Z" }),
          job({ id: "past", name: "Missed", nextRun: "2026-11-18T11:00:00Z" }),
        ],
      }),
      NOW,
    );
    expect(runs.map((r) => r.key)).toEqual(["job:past", "job:soon", "job:late"]);
    expect(runs[0].overdue).toBe(true);
    expect(runs[1].overdue).toBe(false);
    expect(runs[2].detail).toContain("cron 0 13 * * *");
  });

  it("loops are due at lastRun + interval; never-run loops sort last", () => {
    const { runs } = futureRuns(snap({ loops: [loop({ id: "whisper", label: "Whisper ensure" }), loop({ lastRun: NOW - 30_000 }), loop({ id: "droplet", label: "Droplet", lastRun: NOW - 120_000, overdue: true })] }), NOW);
    expect(runs.map((r) => r.key)).toEqual(["loop:droplet", "loop:inbox", "loop:whisper"]);
    expect(runs[0].overdue).toBe(true);
    expect(runs[1]).toMatchObject({ due: NOW + 30_000, overdue: false });
    expect(runs[2]).toMatchObject({ due: null });
    expect(runs[2].detail).toContain("not run yet");
  });

  it("a healthy short-interval loop seen through a stale snapshot is not overdue (Rust's verdict wins)", () => {
    // Phone inbox drain: 3 s interval, last pass 15 s before `now` (snapshot age + clock lag).
    const inbox = futureRuns(snap({ loops: [loop({ intervalSecs: 3, lastRun: NOW - 15_000, overdue: false })] }), NOW).runs[0];
    expect(inbox.overdue).toBe(false);
    expect(inbox.due).not.toBeNull();
    expect(inbox.due!).toBeGreaterThanOrEqual(NOW);
    expect(fmtDue(inbox.due, NOW)).not.toMatch(/overdue/);
    const droplet = futureRuns(snap({ loops: [loop({ id: "droplet", intervalSecs: 15, lastRun: NOW - 20_000, overdue: false })] }), NOW).runs[0];
    expect(droplet.overdue).toBe(false);
    expect(droplet.due!).toBeGreaterThanOrEqual(NOW);
    // Rust says overdue: keep the raw due so the chip says how late it is.
    const late = futureRuns(snap({ loops: [loop({ intervalSecs: 3, lastRun: NOW - 60_000, overdue: true })] }), NOW).runs[0];
    expect(late).toMatchObject({ overdue: true, due: NOW - 57_000 });
  });

  it("n8n workflows that share a name get distinct keys", () => {
    const wf = (name: string, id?: string) => ({ ...(id ? { id } : {}), name, active: true, lastStatus: "", lastRun: null });
    const { runs } = futureRuns(snap({ n8n: [{ id: "n8n", label: "n8n", status: "online", detail: "", workflows: [wf("Triage"), wf("Triage"), wf("Triage", "abc")] }] }), NOW);
    const keys = runs.map((r) => r.key);
    expect(new Set(keys).size).toBe(3);
    expect(keys).toContain("n8n:n8n:abc");
  });

  it("adds active n8n workflows and the slot queue", () => {
    const { runs } = futureRuns(
      snap(
        { n8n: [{ id: "n8n", label: "n8n local", status: "online", detail: "", workflows: [{ name: "Inbox triage", active: true, lastStatus: "success", lastRun: null }, { name: "Old", active: false, lastStatus: "", lastRun: null }] }] },
        { queuedForeground: 1, queuedBackground: 2 },
      ),
      NOW,
    );
    expect(runs.map((r) => r.label)).toEqual(["GPU slot queue", "Inbox triage"]);
    expect(runs[0].detail).toContain("1 foreground · 2 background");
  });

  it("says why the scheduler is missing", () => {
    expect(futureRuns(snap({ schedulerJobs: null, schedulerNote: "gateway down" }), NOW).notes).toEqual(["gateway down"]);
    expect(futureRuns(snap({ schedulerJobs: null }), NOW).notes[0]).toMatch(/scheduler/);
    expect(futureRuns(snap({ n8nNote: "no n8n key" }), NOW).notes).toEqual(["no n8n key"]);
  });

  it("fmtDue", () => {
    expect(fmtDue(null, 0)).toBeNull();
    expect(fmtDue(1000, 0)).toBe("now");
    expect(fmtDue(30_000, 0)).toBe("in 30s");
    expect(fmtDue(5 * 60_000, 0)).toBe("in 5m");
    expect(fmtDue(3 * 3_600_000, 0)).toBe("in 3h");
    expect(fmtDue(0, 5 * 60_000)).toBe("overdue 5m");
  });
});

describe("api key presence", () => {
  const ks = (source: OsKeyStatus["source"], o: Partial<OsKeyStatus> = {}): OsKeyStatus => ({ source, envVar: "X_KEY", keychain: source === "keychain", ...o });
  const sources = (m: Partial<Record<OsSecret, OsKeyStatus>>) => m;

  it("prefers the bus source, then the shared key sources, never values", () => {
    const r = apiKeyPresence(
      [bus({ id: "brave-search", status: "ok", source: "env" }), bus({ id: "gmail", status: "ok", source: "n8n:gmail" }), bus({ id: "spotify", status: "needs_token", source: "none" })],
      sources({ anthropic: ks("keychain"), gemini: ks("missing"), brave: ks("missing") }),
    );
    const by = Object.fromEntries(r.keys.map((k) => [k.name, k]));
    expect(by["Brave Search"]).toEqual({ name: "Brave Search", present: true, via: "env" });
    expect(by.Gmail.present).toBe(true);
    expect(by.Spotify.present).toBe(false);
    expect(by.Anthropic).toMatchObject({ present: true, via: "keychain" });
    expect(by.Gemini).toMatchObject({ present: false, via: "not set" });
    expect(by.ElevenLabs.present).toBeNull();
    expect(r.active).toBe(3);
    // Deduplicated by service: brave appears once even though the keychain also has a "brave" slot.
    expect(r.keys.filter((k) => k.name.startsWith("Brave"))).toHaveLength(1);
    expect(JSON.stringify(r)).not.toMatch(/secret|token=/i);
  });

  it("a key that lives only in .env counts as active", () => {
    const r = apiKeyPresence([], sources({ anthropic: ks("env-file", { keychain: false }), "github-pat": ks("env", { keychain: false }) }));
    const by = Object.fromEntries(r.keys.map((k) => [k.name, k]));
    expect(by.Anthropic).toMatchObject({ present: true, via: "env-file" });
    expect(by.GitHub).toMatchObject({ present: true, via: "env" });
    // Services the store didn't report stay unknown, not "not set".
    expect(by.Gemini.present).toBeNull();
  });

  it("a server merely awaiting a token is muted; a rejected token warns", () => {
    expect(apiKeyPresence([bus({ id: "spotify", status: "needs_token", source: "none" }), bus({ id: "github", status: "needs_token" })], null).warn).toBe(false);
    expect(apiKeyPresence([bus({ id: "github", status: "auth_failed" })], null).warn).toBe(true);
  });

  it("falls back to the key sources when the bus has no source; an incomplete Gmail pair is not set", () => {
    const r = apiKeyPresence(
      [bus({ id: "brave-search", status: "ok" })],
      sources({ brave: ks("env-file"), "gmail-script-id": ks("missing", { pairIncomplete: true }), "gmail-script-key": ks("missing", { pairIncomplete: true }) }),
    );
    const by = Object.fromEntries(r.keys.map((k) => [k.name, k]));
    expect(by["Brave Search"]).toMatchObject({ present: true, via: "env-file" });
    expect(by.Gmail).toMatchObject({ present: false, via: "pair incomplete" });
    // No key-source slot for Spotify (its refresh token is internal): unknown without a bus source.
    expect(by.Spotify.present).toBeNull();
    expect(r.warn).toBe(false);
    const both = apiKeyPresence([], sources({ "gmail-script-id": ks("keychain"), "gmail-script-key": ks("keychain") }));
    expect(both.keys.find((k) => k.name === "Gmail")).toMatchObject({ present: true, via: "keychain" });
  });

  it("unknown without any source", () => {
    const r = apiKeyPresence(null, null);
    expect(r.active).toBe(0);
    expect(r.known).toBe(0);
    expect(r.keys.every((k) => k.present === null)).toBe(true);
  });
});

describe("bus card header", () => {
  it("counts failing and awaiting servers apart", () => {
    expect(busHeaderFix([{ status: "needs_token" }, { status: "ok" }])).toEqual({ failing: 0, awaiting: 1 });
    expect(busHeaderFix([{ status: "auth_failed" }, { status: "error" }, { status: "needs_token" }])).toEqual({ failing: 2, awaiting: 1 });
  });
});

describe("os.json switch guard", () => {
  const cfg = (mode: "local" | "hybrid" | "cloud", delegation: "allow" | "ask" | "deny") => ({ compute: { mode }, permissions: { delegation } }) as unknown as Parameters<typeof osSwitchBlock>[1];

  it("refuses a toggle the live config no longer allows", () => {
    expect(osSwitchBlock("overload", cfg("cloud", "ask"))).toMatch(/cloud/);
    expect(osSwitchBlock("overload", cfg("local", "deny"))).toBeNull();
    expect(osSwitchBlock("delegation", cfg("cloud", "deny"))).toMatch(/deny/);
    expect(osSwitchBlock("delegation", cfg("cloud", "ask"))).toBeNull();
    expect(osSwitchBlock("overload", null)).toMatch(/re-read/);
  });
});

describe("frame gate", () => {
  const FRAME = 1000 / 30;
  it("counts two 60 Hz vsyncs as a frame despite jitter and coarse timestamps", () => {
    expect(frameDue(1000, 0, FRAME)).toBe(true);
    expect(frameDue(1033.3, 1000, FRAME)).toBe(true);
    expect(frameDue(1032.9, 1000, FRAME)).toBe(true);
    // One 60 Hz vsync later is still too soon.
    expect(frameDue(1016.7, 1000, FRAME)).toBe(false);
  });

  it("paints a steady every-other vsync at 60 Hz", () => {
    let last = 0;
    let painted = 0;
    // 60 vsyncs at 16.67 ms with ±0.1 ms jitter, timestamps coarsened to 0.1 ms.
    for (let i = 1; i <= 60; i++) {
      const t = Math.round((i * (1000 / 60) + (i % 2 ? 0.1 : -0.1)) * 10) / 10;
      if (frameDue(t, last, FRAME)) {
        painted++;
        last = t;
      }
    }
    expect(painted).toBe(30);
  });
});
