import { cmd, type McpServer } from "@/lib/platform";
import { useOs } from "@/features/os/os-store";

/** `mcps` with one server switched on/off, or null when it's missing or already in that state. */
export function withMcpEnabled(mcps: McpServer[], id: string, on: boolean): McpServer[] | null {
  const cur = mcps.find((m) => m.id === id);
  if (!cur || cur.enabled === on) return null;
  return mcps.map((m) => (m.id === id ? { ...m, enabled: on } : m));
}

/** `os_config_update` replaces arrays wholesale, so patch the whole list as freshly read from Rust. */
export async function setMcpEnabled(id: string, on: boolean): Promise<void> {
  const cfg = await cmd("os_config_get");
  const mcps = withMcpEnabled(cfg.mcps, id, on);
  if (mcps) await useOs.getState().patch({ mcps });
}
