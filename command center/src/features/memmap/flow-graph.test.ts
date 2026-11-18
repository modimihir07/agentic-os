import { describe, expect, it } from "vitest";
import type { SnapBus, SnapStore, SystemSnapshot, TraceStep } from "@/lib/platform";
import type { IpcCall } from "@/lib/ipc-ring";
import {
  cubicAt,
  EDGE_BY_ID,
  edgeSamples,
  edgesForIpc,
  edgesForStep,
  FLOW_EDGES,
  FLOW_NODES,
  flowLayout,
  flowNodeStatus,
  flowOrientation,
  freshIpc,
  freshTail,
  retimeToNow,
  memWriteDelta,
  NODE_BY_ID,
  pathD,
  pillLabel,
  samplePoint,
  serverOfTool,
  stageOf,
  stripStage,
  toolName,
} from "./flow-graph";

const step = (o: Partial<TraceStep>): TraceStep => ({ traceId: "t1", seq: 0, hop: "tool", zone: "exhaust", label: "", ok: true, ms: 0, at: 0, ...o });
const tool = (label: string, o: Partial<TraceStep> = {}) => edgesForStep(step({ hop: "tool", label, ...o }));

describe("graph", () => {
  it("every edge references existing nodes and ids are unique", () => {
    const ids = new Set(FLOW_NODES.map((n) => n.id));
    expect(ids.size).toBe(FLOW_NODES.length);
    expect(new Set(FLOW_EDGES.map((e) => e.id)).size).toBe(FLOW_EDGES.length);
    for (const e of FLOW_EDGES) {
      expect(ids.has(e.from)).toBe(true);
      expect(ids.has(e.to)).toBe(true);
      expect(e.id).toBe(`${e.from}-${e.to}`);
      expect(EDGE_BY_ID[e.id]).toBe(e);
    }
  });

  it("has the requested columns", () => {
    const col = (c: number) => FLOW_NODES.filter((n) => n.column === c).map((n) => n.label);
    expect(col(0).sort()).toEqual(["Gmail API", "Local Filesystem", "Memory Mapping", "Telemetry", "Voice / Audio Engine"]);
    expect(col(1).sort()).toEqual(["Brave Search", "MCP Server Hub", "Tony Dispatcher"]);
    expect(col(2).sort()).toEqual(["Spotify / Media Output", "Sub-Agent Execution", "Write to Memory Database"]);
    expect(NODE_BY_ID.voice.zone).toBe("cockpit");
    expect(NODE_BY_ID.telemetry.zone).toBe("ecu");
    expect(NODE_BY_ID.memwrite.zone).toBe("cargo");
    expect(NODE_BY_ID.subagents.zone).toBe("engine");
    expect(NODE_BY_ID.gmail.zone).toBe("exhaust");
  });

  it("outbound edges are amber, inbound cyan", () => {
    expect(EDGE_BY_ID["gmail-hub"].tone).toBe("cyan");
    expect(EDGE_BY_ID["hub-tony"].tone).toBe("cyan");
    expect(EDGE_BY_ID["hub-media"].tone).toBe("amber");
    expect(EDGE_BY_ID["tony-voice"].tone).toBe("amber");
    expect(EDGE_BY_ID["tony-memwrite"].tone).toBe("amber");
  });
});

describe("labels", () => {
  it("stripStage drops a pipeline stage prefix only", () => {
    expect(stripStage("build · fs.read", "pipeline:abc")).toBe("fs.read");
    expect(stripStage("review · overseer · coder", "pipeline:abc")).toBe("overseer · coder");
    expect(stripStage("lmstudio · qwen", "t1")).toBe("lmstudio · qwen");
    expect(stripStage("fs.read", "pipeline:abc")).toBe("fs.read");
    expect(stageOf({ label: "ledger · librarian replied", traceId: "pipeline:x" })).toBe("ledger");
    expect(stageOf({ label: "ledger · librarian replied", traceId: "t" })).toBeNull();
    expect(toolName({ label: "build ·  web.search ", traceId: "pipeline:x" })).toBe("web.search");
  });

  it("serverOfTool mirrors Rust mcp::server_of_tool", () => {
    expect(serverOfTool("fs.read")).toBe("filesystem");
    expect(serverOfTool("fs.list")).toBe("filesystem");
    expect(serverOfTool("kg.search")).toBe("knowledge-graph");
    expect(serverOfTool("web.search")).toBe("brave-search");
    expect(serverOfTool("gmail.recent")).toBe("gmail");
    expect(serverOfTool("spotify.play")).toBe("spotify");
    expect(serverOfTool("weather.current")).toBe("weather");
    expect(serverOfTool("whatsapp.send_message")).toBe("whatsapp");
    expect(serverOfTool("skills.read")).toBe("skills");
    expect(serverOfTool("bare")).toBe("bare");
  });
});

describe("edgesForStep", () => {
  it("maps every built-in tool (mcp.rs call_tool) to its edge, always plus hub → Tony", () => {
    const cases: [string, string | null][] = [
      ["weather.current", null],
      ["time.now", null],
      ["fetch.url", null],
      ["fs.list", "fs-hub"],
      ["fs.read", "fs-hub"],
      ["git.status", "fs-hub"],
      ["kg.search", "memory-hub"],
      ["web.search", "hub-brave"],
      ["gmail.recent", "gmail-hub"],
      ["gmail.search", "gmail-hub"],
      ["gmail.read_thread", "gmail-hub"],
      ["gmail.create_draft", "gmail-hub"],
      ["gmail-multi.search", "gmail-hub"],
      ["spotify.now_playing", "hub-media"],
      ["spotify.recent", "hub-media"],
      ["spotify.playlists", "hub-media"],
      ["spotify.play", "hub-media"],
      ["spotify.pause", "hub-media"],
      ["spotify.resume", "hub-media"],
      ["spotify.next", "hub-media"],
      ["spotify.previous", "hub-media"],
      ["spotify.volume", "hub-media"],
      ["skills.read", null],
      ["whatsapp.list_chats", null],
    ];
    for (const [name, e] of cases) {
      const hit = tool(name);
      if (e) expect(hit, name).toEqual({ edges: [e, "hub-tony"], ok: true });
      else expect(hit, name).toEqual({ edges: ["hub-tony"], flash: "hub", ok: true });
    }
  });

  it("a standalone tool trace (fresh uuid, seq 0) still pulses the hub", () => {
    expect(tool("whatsapp.send_message", { traceId: "5d1c-uuid", seq: 0 }).edges).toContain("hub-tony");
  });

  it("pipeline tool labels carry the stage prefix", () => {
    expect(tool("build · fs.read", { traceId: "pipeline:p1" })).toEqual({ edges: ["fs-hub", "hub-tony"], ok: true });
    expect(tool("research · web.search", { traceId: "pipeline:p1" }).edges[0]).toBe("hub-brave");
  });

  it("a gate refusal (PERMISSION_*) is not ok and stops at the hub", () => {
    const hit = tool("gmail.search", { ok: false, error: "PERMISSION_DENIED:mcp" });
    expect(hit.ok).toBe(false);
    expect(hit.flash).toBe("hub");
    expect(hit.edges).toEqual(["hub-tony"]);
    expect(tool("fs.read", { ok: true, error: "PERMISSION_REQUIRED:filesystem" }).ok).toBe(false);
    expect(tool("fs.read", { ok: false, error: "no such file" })).toEqual({ edges: ["fs-hub", "hub-tony"], ok: false });
  });

  it("model hops: overseer and anythingllm/ are sub-agents; the main chain flashes Tony", () => {
    expect(edgesForStep(step({ hop: "model", label: "review · overseer · coder", traceId: "pipeline:p" })).edges).toEqual(["tony-subagents"]);
    expect(edgesForStep(step({ hop: "model", label: "overseer · claude-cli" })).edges).toEqual(["tony-subagents"]);
    expect(edgesForStep(step({ hop: "model", label: "Coder · anythingllm/coder" })).edges).toEqual(["tony-subagents"]);
    const chain = edgesForStep(step({ hop: "model", label: "anythingllm · qwen" }));
    expect(chain.edges).toEqual([]);
    expect(chain.flash).toBe("tony");
    expect(edgesForStep(step({ hop: "model", label: "lmstudio · qwen2.5-7b" })).flash).toBe("tony");
  });

  it("memory hops: Tony reads; anythingllm/ also runs a sub-agent; the ledger writes memory", () => {
    expect(edgesForStep(step({ hop: "memory", label: "comms history search" })).edges).toEqual(["memory-tony"]);
    expect(edgesForStep(step({ hop: "memory", label: "Librarian · anythingllm/librarian" })).edges).toEqual(["memory-tony", "tony-subagents"]);
    expect(edgesForStep(step({ hop: "memory", label: "ledger · librarian replied", traceId: "pipeline:p" }))).toEqual({ edges: ["tony-memwrite"], ok: true });
    expect(edgesForStep(step({ hop: "memory", label: "ledger · librarian failed", traceId: "pipeline:p", ok: false }))).toEqual({ edges: ["tony-memwrite"], ok: false });
  });

  it("router / rules", () => {
    expect(edgesForStep(step({ hop: "router", label: "chat → Tony" })).flash).toBe("tony");
    expect(edgesForStep(step({ hop: "router", label: "build · os → coder", traceId: "pipeline:p" })).edges).toEqual(["tony-subagents"]);
    expect(edgesForStep(step({ hop: "router", label: "ledger · os → librarian", traceId: "pipeline:p" })).flash).toBe("tony");
    expect(edgesForStep(step({ hop: "rules", label: "MASTER_IDENTITY.md → Tony" })).edges).toEqual(["fs-tony"]);
    expect(edgesForStep(step({ hop: "rules", label: "review · handoff verifier", traceId: "pipeline:p" })).edges).toEqual(["tony-subagents"]);
  });

  it("voice hops", () => {
    expect(edgesForStep(step({ hop: "vad", label: "speech start → end" })).edges).toEqual(["voice-tony"]);
    expect(edgesForStep(step({ hop: "stt", label: "whisper" })).edges).toEqual(["voice-tony"]);
    expect(edgesForStep(step({ hop: "input", label: "voice line" })).edges).toEqual(["voice-tony"]);
    expect(edgesForStep(step({ hop: "input", label: "typed line" })).flash).toBe("tony");
    expect(edgesForStep(step({ hop: "tts", label: "kokoro" })).edges).toEqual(["tony-voice"]);
    expect(edgesForStep(step({ hop: "ui", label: "reply shown" })).flash).toBe("tony");
    expect(edgesForStep(step({ hop: "stt", label: "whisper", ok: false })).ok).toBe(false);
  });

  it("every edge a step can produce exists", () => {
    const labels = ["fs.read", "kg.search", "gmail.recent", "spotify.play", "web.search", "x.y", "a · anythingllm/b", "overseer · c", "voice line", "ledger · librarian replied"];
    const hops: TraceStep["hop"][] = ["input", "vad", "stt", "router", "rules", "memory", "model", "tool", "tts", "ui"];
    for (const hop of hops)
      for (const label of labels)
        for (const traceId of ["t", "pipeline:p"]) for (const e of edgesForStep(step({ hop, label, traceId })).edges) expect(EDGE_BY_ID[e]).toBeDefined();
  });
});

describe("edgesForIpc", () => {
  const call = (name: string, ok = true): IpcCall => ({ name, ms: 3, ok, at: 1 });

  it("dev-task and memory writes light the Memory DB node only (no Tony edge)", () => {
    for (const n of ["dev_task_add", "dev_task_update", "dev_task_delete", "memory_harvest", "memory_flush", "memory_mount"]) expect(edgesForIpc(call(n))).toEqual({ edges: [], flash: "memwrite", ok: true });
  });

  it("direct Spotify commands light the media node", () => {
    for (const n of ["spotify_control", "spotify_play", "spotify_play_uri"]) expect(edgesForIpc(call(n, false))).toEqual({ edges: [], flash: "media", ok: false });
  });

  it("reads and polls give nothing", () => {
    for (const n of ["spotify_now_playing", "spotify_status", "system_introspect", "os_secret_status", "dev_task_list"]) expect(edgesForIpc(call(n))).toBeNull();
  });
});

describe("fresh tails", () => {
  it("freshTail / freshIpc follow identity", () => {
    const a = { name: "a", ms: 0, ok: true, at: 0 };
    const b = { name: "b", ms: 0, ok: true, at: 0 };
    const c = { name: "c", ms: 0, ok: true, at: 0 };
    expect(freshIpc([a, b, c], a)).toEqual([b, c]);
    expect(freshIpc([a, b, c], c)).toEqual([]);
    expect(freshIpc([], c)).toEqual([]);
    expect(freshIpc([b, c], { ...a })).toEqual([b, c]);
    expect(freshIpc([a, b, c], undefined, 2)).toEqual([b, c]);
    expect(freshTail([1, 2, 3], 2)).toEqual([3]);
  });
});

const store = (o: Partial<SnapStore> & { id: SnapStore["id"] }): SnapStore => ({ label: o.id, kind: "sqlite", exists: true, health: "ok", tables: [], metrics: {}, ...o });
const snapWith = (o: Partial<SystemSnapshot>): SystemSnapshot =>
  ({
    at: 0,
    deep: false,
    tookMs: 0,
    uptimeSecs: 0,
    host: { cpuBrand: null, cpuThreads: 16, cpuPct: 12 },
    services: [],
    chain: [],
    agents: [],
    agentsNote: null,
    slot: { active: [], queuedForeground: 0, queuedBackground: 0, capacity: 1 },
    routines: { loops: [], schedulerJobs: [], schedulerNote: null, n8nConfigured: [], n8n: [], n8nNote: null },
    stores: [],
    bus: [],
    summary: { uptimeSecs: 0, cpuPct: null, memUsedMb: null, memTotalMb: null, gpuUtilPct: null, vramUsedMb: null, vramTotalMb: null, servicesUp: 0, servicesTotal: 0, skills: 0, storesOk: 0, storesTotal: 0 },
    ...o,
  }) as unknown as SystemSnapshot;

describe("memWriteDelta", () => {
  it("sums growth of counters present in both snapshots", () => {
    const a = snapWith({ stores: [store({ id: "devqueue", tables: [{ name: "dev_task_queue", rows: 3 }] }), store({ id: "training-logs", metrics: { todayLines: 10 } }), store({ id: "cc", metrics: { vaultItems: 5 } })] });
    const b = snapWith({ stores: [store({ id: "devqueue", tables: [{ name: "dev_task_queue", rows: 4 }] }), store({ id: "training-logs", metrics: { todayLines: 12 } }), store({ id: "cc", metrics: { vaultItems: 5 } })] });
    expect(memWriteDelta(a, b)).toBe(3);
    expect(memWriteDelta(b, a)).toBe(0);
    expect(memWriteDelta(null, b)).toBe(0);
    expect(memWriteDelta(a, null)).toBe(0);
  });

  it("ignores null counters", () => {
    const a = snapWith({ stores: [store({ id: "devqueue", tables: [{ name: "q", rows: null }] }), store({ id: "cc", metrics: { vaultItems: null } })] });
    const b = snapWith({ stores: [store({ id: "devqueue", tables: [{ name: "q", rows: 40 }] }), store({ id: "cc", metrics: { vaultItems: 9 } })] });
    expect(memWriteDelta(a, b)).toBe(0);
  });
});

describe("flowNodeStatus", () => {
  const bus = (o: Partial<SnapBus> & { id: string; status: SnapBus["status"] }): SnapBus => ({ name: o.id, transport: "builtin", error: null, tools: null, ...o });

  it("without a snapshot every node is idle with the reason", () => {
    const s = flowNodeStatus(null, { why: "desktop only" });
    for (const n of FLOW_NODES) expect(s[n.id].tone).toBe("idle");
    expect(s.hub.why).toBe("desktop only");
    expect(flowNodeStatus(null, { voice: "error" }).voice.tone).toBe("down");
  });

  it("reads the bus, services, stores and chain", () => {
    const snap = snapWith({
      bus: [bus({ id: "gmail", status: "needs_token" }), bus({ id: "brave-search", status: "ok", source: "env" }), bus({ id: "spotify", status: "ok" }), bus({ id: "filesystem", status: "ok" }), bus({ id: "git", status: "error", error: "git missing" }), bus({ id: "time", status: "off" })],
      services: [
        { id: "whisper", label: "Whisper", kind: "stt", up: true, latencyMs: 3, detail: "200", port: 8178 },
        { id: "kokoro", label: "Kokoro", kind: "tts", up: false, latencyMs: 0, detail: "refused", port: 8880 },
        { id: "lmstudio", label: "LM Studio", kind: "local", up: true, latencyMs: 9, detail: "200", port: 1235 },
      ],
      chain: [{ id: "lmstudio", label: "LM Studio", kind: "local", model: "qwen", local: true }],
      stores: [store({ id: "cc" }), store({ id: "devqueue", writable: false })],
      summary: { storesOk: 2, storesTotal: 2 } as SystemSnapshot["summary"],
    });
    const s = flowNodeStatus(snap, { voice: "idle" });
    expect(s.gmail).toMatchObject({ tone: "idle", text: "Awaiting token" });
    expect(s.brave.tone).toBe("ok");
    expect(s.brave.why).toContain("key source: env");
    expect(s.fs.tone).toBe("down");
    expect(s.fs.why).toContain("git missing");
    expect(s.media.tone).toBe("ok");
    expect(s.hub).toMatchObject({ tone: "warn", text: "3/5 connected" });
    expect(s.voice).toMatchObject({ tone: "warn", text: "1/2 up" });
    expect(s.tony.tone).toBe("ok");
    expect(s.memory).toMatchObject({ tone: "ok", text: "2/2 ok" });
    expect(s.memwrite).toMatchObject({ tone: "warn", text: "1/2 writable" });
    expect(s.subagents.tone).toBe("idle");
    expect(s.telemetry.tone).toBe("ok");
  });

  it("missing sources read idle with a why", () => {
    const s = flowNodeStatus(snapWith({}));
    expect(s.gmail).toMatchObject({ tone: "idle", text: "—" });
    expect(s.gmail.why).toMatch(/os\.json/);
    expect(s.tony.why).toMatch(/chain/);
    expect(s.voice.why).toMatch(/STT/);
  });
});

describe("geometry", () => {
  it("horizontal layout keeps the three columns left → right inside the box", () => {
    const L = flowLayout(1000, 140, "h");
    for (const n of FLOW_NODES) {
      const b = L.nodes[n.id];
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.y).toBeGreaterThanOrEqual(0);
      expect(b.x + b.w).toBeLessThanOrEqual(1000);
      expect(b.y + b.h).toBeLessThanOrEqual(140);
    }
    expect(L.nodes.gmail.x + L.nodes.gmail.w).toBeLessThan(L.nodes.hub.x);
    expect(L.nodes.hub.x + L.nodes.hub.w).toBeLessThan(L.nodes.media.x);
    // Forward edges start on the source's right edge and end on the target's left edge.
    const [s, , , t] = L.paths["gmail-hub"];
    expect(s[0]).toBeCloseTo(L.nodes.gmail.x + L.nodes.gmail.w);
    expect(t[0]).toBeCloseTo(L.nodes.hub.x);
    // The backward Tony → Voice edge does not sit exactly on Voice → Tony.
    expect(L.paths["tony-voice"][0][1]).not.toBe(L.paths["voice-tony"][3][1]);
  });

  it("vertical layout stacks sources, routing, destinations top → bottom", () => {
    const L = flowLayout(340, 280, "v");
    expect(L.nodes.gmail.y).toBeLessThan(L.nodes.hub.y);
    expect(L.nodes.hub.y).toBeLessThan(L.nodes.memwrite.y);
    for (const n of FLOW_NODES) expect(L.nodes[n.id].x + L.nodes[n.id].w).toBeLessThanOrEqual(340);
    const [s, , , t] = L.paths["hub-tony"];
    expect(s[1]).toBeCloseTo(L.nodes.hub.y + L.nodes.hub.h / 2);
    expect(t[1]).toBeCloseTo(L.nodes.tony.y + L.nodes.tony.h / 2);
  });

  it("orientation switches at the minimum width", () => {
    expect(flowOrientation(900)).toBe("h");
    expect(flowOrientation(400)).toBe("h");
    expect(flowOrientation(340)).toBe("v");
  });

  it("edgeSamples precomputes n + 1 points from start to end of every edge", () => {
    const L = flowLayout(800, 140, "h");
    const S = edgeSamples(L, 24);
    for (const e of FLOW_EDGES) {
      const pts = S[e.id];
      expect(pts).toHaveLength(25);
      expect(pts[0][0]).toBeCloseTo(L.paths[e.id][0][0]);
      expect(pts[24][1]).toBeCloseTo(L.paths[e.id][3][1]);
      for (const p of pts) expect(Number.isFinite(p[0]) && Number.isFinite(p[1])).toBe(true);
    }
  });

  it("cubicAt / samplePoint / pathD", () => {
    const c: [[number, number], [number, number], [number, number], [number, number]] = [
      [0, 0],
      [10, 0],
      [20, 10],
      [30, 10],
    ];
    expect(cubicAt(c, 0)).toEqual([0, 0]);
    expect(cubicAt(c, 1)).toEqual([30, 10]);
    expect(cubicAt(c, 0.5)).toEqual([15, 5]);
    expect(samplePoint([[0, 0], [10, 0]], 0.25)).toEqual([2.5, 0]);
    expect(samplePoint([[0, 0], [10, 0]], 2)).toEqual([10, 0]);
    expect(samplePoint([], 0.5)).toBeNull();
    expect(pathD(c)).toBe("M0.0,0.0 C10.0,0.0 20.0,10.0 30.0,10.0");
  });

  it("pillLabel shortens labels that don't fit", () => {
    expect(pillLabel(NODE_BY_ID.memwrite, 200)).toBe("Write to Memory Database");
    expect(pillLabel(NODE_BY_ID.memwrite, 90)).toBe("Mem DB");
    expect(pillLabel(NODE_BY_ID.telemetry, 62)).toBe("Telem…");
    expect(pillLabel(NODE_BY_ID.telemetry, 10)).toBe("T…");
  });
});

describe("travel/static switch", () => {
  it("retimeToNow pulls future births and arrivals to now so one static prune clears them", () => {
    const pulses = [{ born: 100 }, { born: 900 }, { born: 1400 }];
    const flashes = new Map([
      ["a", { at: 50 }],
      ["b", { at: 1900 }],
    ]);
    retimeToNow(pulses, flashes.values(), 1000);
    expect(pulses.map((p) => p.born)).toEqual([100, 900, 1000]);
    expect(flashes.get("a")!.at).toBe(50);
    expect(flashes.get("b")!.at).toBe(1000);
  });
});
