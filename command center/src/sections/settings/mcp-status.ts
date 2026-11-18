import type { McpServer, ServerTools } from "@/lib/platform";

/** Reload the MCP listing whenever anything that decides how a server starts changes
 * (not just id / enabled): editing the command, args, URL, working folder or timeout
 * must re-list at once (the Rust caches are keyed by the same config). */
export function mcpReloadKey(mcps: readonly McpServer[]): string {
  return JSON.stringify(mcps.map((m) => [m.id, m.enabled, m.transport, m.command, m.args, m.url, m.cwd ?? null, m.timeoutSecs ?? null, !!m.readOnly]));
}

/** How one server's listing reads in the registry card: muted for "awaiting token" and
 * "starting" (neither is a failure), red only for a real error. */
export function mcpStatusView(t: ServerTools): { text: string; tone: "ok" | "muted" | "pending" | "error"; title?: string } {
  if (t.ok) return { text: `${t.tools.length} tool${t.tools.length === 1 ? "" : "s"}`, tone: "ok" };
  switch (t.status) {
    case "needs_token":
      return { text: "Awaiting token", tone: "muted", title: t.error ?? undefined };
    case "starting":
      return { text: "starting…", tone: "pending", title: t.error ?? "Cold start in progress — its tools will appear shortly." };
    case "auth_failed":
      return { text: "token rejected — update it", tone: "error", title: t.error ?? undefined };
    default:
      return { text: (t.error ?? "error").slice(0, 80), tone: "error", title: t.error ?? undefined };
  }
}

/** Any server still cold-starting (the card polls until it settles). */
export function anyStarting(tools: readonly ServerTools[] | null): boolean {
  return !!tools?.some((t) => t.enabled && t.status === "starting");
}

/** The timeout field (cold start; above 60 s also each tool call): blank = default (null), else a whole number 5–600. */
export function parseTimeoutSecs(raw: string): { ok: true; value: number | null } | { ok: false; error: string } {
  const s = raw.trim();
  if (!s) return { ok: true, value: null };
  if (!/^\d+$/.test(s)) return { ok: false, error: "Timeout: whole seconds, 5–600." };
  const n = Number(s);
  if (n < 5 || n > 600) return { ok: false, error: "Timeout must be 5–600 seconds." };
  return { ok: true, value: n };
}

/** The working-folder field: blank = the repo (null), else an absolute path. */
export function parseCwd(raw: string): { ok: true; value: string | null } | { ok: false; error: string } {
  const s = raw.trim().replace(/^"|"$/g, "");
  if (!s) return { ok: true, value: null };
  const absolute = /^[A-Za-z]:[\\/]/.test(s) || s.startsWith("\\\\");
  if (!absolute || s.length > 1024) return { ok: false, error: "Working folder must be an absolute path (e.g. D:\\projects\\app)." };
  return { ok: true, value: s };
}
