import { create } from "zustand";
import { cmd, isTauri, type PolicyPatch, type ProviderPatch, type ProvidersView } from "@/lib/platform";

/** providers.json, as the Settings dropdowns see and edit it (desktop only). */
interface ProvidersState {
  view: ProvidersView | null;
  error: string | null;
  saving: boolean;
  load: () => Promise<void>;
  patch: (p: ProviderPatch) => Promise<void>;
  policy: (p: PolicyPatch) => Promise<void>;
  apply: (v: Promise<ProvidersView>) => Promise<void>;
}

export const useProviders = create<ProvidersState>((set, get) => ({
  view: null,
  error: null,
  saving: false,
  load: async () => {
    if (!isTauri()) return;
    try {
      set({ view: await cmd("providers_list"), error: null });
    } catch (e) {
      set({ error: String(e) });
    }
  },
  apply: async (p) => {
    set({ saving: true });
    try {
      set({ view: await p, error: null });
    } catch (e) {
      set({ error: String(e) });
      throw e;
    } finally {
      set({ saving: false });
    }
  },
  patch: (patch) => get().apply(cmd("providers_update", { patch })),
  policy: (patch) => get().apply(cmd("policy_update", { patch })),
}));

const modelCache = new Map<string, { at: number; models: string[] }>();

/** Models a provider offers (cached 30 s). Errors surface as an empty list + message. */
export async function modelsFor(id: string, force = false): Promise<{ models: string[]; error?: string }> {
  const hit = modelCache.get(id);
  if (!force && hit && Date.now() - hit.at < 30_000) return { models: hit.models };
  try {
    const models = await cmd("provider_models", { id });
    modelCache.set(id, { at: Date.now(), models });
    return { models };
  } catch (e) {
    return { models: [], error: String(e) };
  }
}
