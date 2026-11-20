import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SPOTIFY_TOOL_NAMES } from "@/lib/platform";

/**
 * The 23 Spotify tool names exist twice: Rust `spotify_intent::ALL_TOOLS` (the grammar, the MCP
 * registry, the router) and TS `SPOTIFY_TOOL_NAMES` (IPC types). This keeps them equal.
 */
const RUST = fileURLToPath(new URL("../../../src-tauri/src/commands/spotify_intent.rs", import.meta.url));
const src = readFileSync(RUST, "utf8");
const decl = /pub const ALL_TOOLS\s*:\s*\[&str;\s*(\d+)\]\s*=\s*\[([\s\S]*?)\];/.exec(src);

describe("Spotify tool names: Rust ALL_TOOLS == TS SPOTIFY_TOOL_NAMES", () => {
  // Until WP-B lands spotify_intent.rs is a one-line stub with no ALL_TOOLS; once it exists this is strict.
  it.skipIf(!decl)("same names, same order, declared length matches", () => {
    const rust = [...decl![2].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(rust).toHaveLength(Number(decl![1]));
    expect(new Set(rust).size).toBe(rust.length);
    expect(rust).toEqual([...SPOTIFY_TOOL_NAMES]);
  });

  it("the TS list is the 23 unique spotify.* names", () => {
    expect(SPOTIFY_TOOL_NAMES).toHaveLength(23);
    expect(new Set(SPOTIFY_TOOL_NAMES).size).toBe(23);
    for (const n of SPOTIFY_TOOL_NAMES) expect(n).toMatch(/^spotify\.[a-z_]+$/);
  });
});
