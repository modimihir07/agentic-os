import { create } from "zustand";
import { gateway } from "@/lib/gateway";
import { cmd, isTauri, type OsConfig, type OsConfigPatch } from "@/lib/platform";
import { useSettings } from "@/stores/settings";
import { roleLabel } from "@/features/dispatcher/roles";

/**
 * The OS core config (identity, compute mode, droplet, skills/MCP, privacy,
 * memory). Desktop: Rust owns it (os.json). Phone: read-only mirror from the
 * gateway (`/api/os/state`). The OS name is also mirrored into persisted
 * settings so every header shows "TONY" instantly on boot.
 */
interface OsStore {
  cfg: OsConfig | null;
  error: string | null;
  saving: boolean;
  load: () => Promise<void>;
  patch: (p: OsConfigPatch) => Promise<OsConfig | null>;
}

const mirror = (name?: string, words?: string[]) => {
  if (!name) return;
  const s = useSettings.getState();
  if (s.osName !== name || (words && words.join("|") !== s.wakeWords.join("|"))) s.set({ osName: name, ...(words ? { wakeWords: words } : {}) });
};

export const useOs = create<OsStore>((set) => ({
  cfg: null,
  error: null,
  saving: false,
  load: async () => {
    try {
      if (isTauri()) {
        const cfg = await cmd("os_config_get");
        set({ cfg, error: null });
        mirror(cfg.osName, cfg.wakeWords);
      } else {
        const st = await gateway<{ osName?: string; wakeWords?: string[] }>("/api/os/state");
        mirror(st.osName, st.wakeWords);
      }
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },
  patch: async (p) => {
    if (!isTauri()) return null;
    set({ saving: true });
    try {
      const cfg = await cmd("os_config_update", { patch: p });
      set({ cfg, error: null, saving: false });
      mirror(cfg.osName, cfg.wakeWords);
      return cfg;
    } catch (e) {
      set({ error: String(e), saving: false });
      throw e;
    }
  },
}));

/** "Tony" (or whatever the user called their OS). */
export const useOsName = () => useSettings((s) => s.osName || "Tony");
export const osName = () => useSettings.getState().osName || "Tony";

/** Display label for an agent id used in inter-agent badges. */
export function agentBadge(id: string): string {
  switch (id) {
    case "os":
      return osName().toUpperCase();
    case "booking":
      return "BOOKING AGENT";
    case "coder":
      return "CODER AGENT";
    case "librarian":
      return "LIBRARIAN";
    case "ops":
      return "OPS AGENT";
    case "prompter":
      return "PROMPTER";
    case "designer":
      return "DESIGNER";
    case "general":
      return osName().toUpperCase();
    case "user":
      return "YOU";
    default:
      // Any role id not special-cased above (e.g. one added to roles.ts later) still
      // gets a real display label instead of a raw-id fallback.
      return roleLabel(id).toUpperCase();
  }
}
