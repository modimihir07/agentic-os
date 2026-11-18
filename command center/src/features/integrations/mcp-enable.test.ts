import { describe, expect, it } from "vitest";
import type { McpServer } from "@/lib/platform";
import { withMcpEnabled } from "./mcp-enable";

const srv = (id: string, enabled: boolean, extra: Partial<McpServer> = {}): McpServer => ({
  id, name: id, transport: "builtin", command: "", args: [], env: {}, url: "", enabled, builtin: true, description: "", ...extra,
});

describe("withMcpEnabled", () => {
  it("flips only the named server and keeps every other field and entry", () => {
    const mcps = [srv("gmail", true, { agents: ["booking"] }), srv("spotify", false), srv("custom", true, { transport: "stdio", command: "npx", builtin: false })];
    const next = withMcpEnabled(mcps, "spotify", true)!;
    expect(next).toHaveLength(3);
    expect(next[1]).toEqual({ ...mcps[1], enabled: true });
    expect(next[0]).toBe(mcps[0]);
    expect(next[2]).toBe(mcps[2]);
  });

  it("returns null when there is nothing to patch", () => {
    expect(withMcpEnabled([srv("spotify", true)], "spotify", true)).toBeNull();
    expect(withMcpEnabled([srv("gmail", true)], "spotify", true)).toBeNull();
  });
});
