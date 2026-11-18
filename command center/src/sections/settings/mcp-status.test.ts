import { describe, expect, it } from "vitest";
import type { McpServer, ServerTools } from "@/lib/platform";
import { anyStarting, mcpReloadKey, mcpStatusView, parseCwd, parseTimeoutSecs } from "./mcp-status";

const srv = (over: Partial<McpServer> = {}): McpServer => ({ id: "s", name: "S", transport: "stdio", command: "npx", args: ["-y", "x"], env: {}, url: "", enabled: true, builtin: false, description: "", ...over });
const st = (over: Partial<ServerTools> = {}): ServerTools => ({ id: "s", name: "S", enabled: true, ok: false, error: null, tools: [], status: "error", auth: null, ...over });

describe("mcpReloadKey", () => {
  it("changes when anything that decides how a server starts changes", () => {
    const base = mcpReloadKey([srv()]);
    expect(mcpReloadKey([srv()])).toBe(base);
    for (const over of [{ command: "uvx" }, { args: ["-y", "y"] }, { url: "http://x" }, { cwd: "D:\\w" }, { timeoutSecs: 90 }, { enabled: false }, { transport: "http" as const }, { readOnly: true }]) {
      expect(mcpReloadKey([srv(over)])).not.toBe(base);
    }
    // Cosmetic edits (description, grants) don't trigger a re-list.
    expect(mcpReloadKey([srv({ description: "new", agents: ["coder"] })])).toBe(base);
  });
});

describe("mcpStatusView", () => {
  it("is muted for a missing token, pending while starting, red only for errors", () => {
    expect(mcpStatusView(st({ ok: true, status: "ok", tools: [{ name: "a", description: "", server: "s", args: [] }] }))).toEqual({ text: "1 tool", tone: "ok" });
    expect(mcpStatusView(st({ status: "needs_token", error: "Sentry: needs a Sentry auth token (no token set)" }))).toMatchObject({ text: "Awaiting token", tone: "muted" });
    expect(mcpStatusView(st({ status: "starting", error: "Serena is still starting" }))).toMatchObject({ text: "starting…", tone: "pending" });
    expect(mcpStatusView(st({ status: "auth_failed" })).tone).toBe("error");
    expect(mcpStatusView(st({ status: "error", error: "x".repeat(200) })).text).toHaveLength(80);
    expect(mcpStatusView(st({ status: "error" })).text).toBe("error");
  });

  it("anyStarting only counts enabled servers", () => {
    expect(anyStarting(null)).toBe(false);
    expect(anyStarting([st({ status: "ok" })])).toBe(false);
    expect(anyStarting([st({ status: "starting" })])).toBe(true);
    expect(anyStarting([st({ status: "starting", enabled: false })])).toBe(false);
  });
});

describe("field parsing", () => {
  it("startup timeout: blank = default, 5–600 whole seconds", () => {
    expect(parseTimeoutSecs("")).toEqual({ ok: true, value: null });
    expect(parseTimeoutSecs(" 120 ")).toEqual({ ok: true, value: 120 });
    expect(parseTimeoutSecs("5")).toEqual({ ok: true, value: 5 });
    expect(parseTimeoutSecs("600")).toEqual({ ok: true, value: 600 });
    for (const bad of ["4", "601", "1.5", "-3", "abc"]) expect(parseTimeoutSecs(bad).ok).toBe(false);
  });

  it("working folder: blank = repo, else absolute", () => {
    expect(parseCwd("")).toEqual({ ok: true, value: null });
    expect(parseCwd('"D:\\Art Apps\\agentic os"')).toEqual({ ok: true, value: "D:\\Art Apps\\agentic os" });
    expect(parseCwd("C:/x")).toEqual({ ok: true, value: "C:/x" });
    expect(parseCwd("\\\\server\\share")).toMatchObject({ ok: true });
    expect(parseCwd("relative\\dir").ok).toBe(false);
    // No drive: not absolute on Windows (matches os_core's Path::is_absolute check).
    expect(parseCwd("/x").ok).toBe(false);
  });
});
