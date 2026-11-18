import { create } from "zustand";
import { cmd, isTauri, type DevBriefExport, type DevTask, type DevTaskPriority, type NativeCommands } from "@/lib/platform";
import { useNav } from "@/stores/nav";
import { useSettings } from "@/stores/settings";
import { useVoice } from "@/features/voice/voice-store";
import { notifyDevQueueChanged, onDevQueueChanged, uiState } from "./devqueue-events";
import { nextPriority, nextStatus, sortTasks, upsertTask, type CategoryFilter } from "./format";

/**
 * The TaskDock's view of the Rust-owned dev task queue (`devqueue.db`). Every write goes
 * through a `dev_task_*` command and the returned row replaces the local one, so the list
 * always shows what SQLite holds. Desktop only.
 */

export const QUEUE_DESKTOP_ONLY = "The dev task queue lives in the desktop app.";

type AddArgs = NativeCommands["dev_task_add"]["args"];

interface DevQueueState {
  tasks: DevTask[];
  loaded: boolean;
  error: string | null;
  filter: CategoryFilter;
  showDone: boolean;
  exporting: boolean;
  lastExport: { path: string; at: number } | null;
  setFilter: (f: CategoryFilter) => void;
  setShowDone: (v: boolean) => void;
  load: () => Promise<void>;
  /** `ui` defaults to the current voice/section/view state. Returns the stored task. */
  add: (args: AddArgs) => Promise<DevTask>;
  cycleStatus: (id: string) => Promise<void>;
  cyclePriority: (id: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  exportBrief: () => Promise<DevBriefExport>;
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The UI keys a snapshot keeps, from the live stores. */
export function currentUi(extra: { sttEngine?: string; ttsEngine?: string } = {}) {
  const v = useVoice.getState();
  return uiState({
    voiceState: v.state,
    listening: v.state === "listening",
    section: useNav.getState().section,
    thread: v.activeThread,
    viewMode: useSettings.getState().systemMapMode,
    ...extra,
  });
}

export const useDevQueue = create<DevQueueState>((set, get) => {
  const replace = (t: DevTask) => set((s) => ({ tasks: upsertTask(s.tasks, t), error: null }));
  const need = () => {
    if (!isTauri()) throw new Error(QUEUE_DESKTOP_ONLY);
  };
  return {
    tasks: [],
    loaded: false,
    error: isTauri() ? null : QUEUE_DESKTOP_ONLY,
    filter: "all",
    showDone: false,
    exporting: false,
    lastExport: null,
    setFilter: (filter) => set({ filter }),
    setShowDone: (showDone) => set({ showDone }),

    load: async () => {
      if (!isTauri()) return set({ error: QUEUE_DESKTOP_ONLY });
      try {
        set({ tasks: sortTasks(await cmd("dev_task_list", {})), loaded: true, error: null });
      } catch (e) {
        set({ error: msg(e), loaded: true });
      }
    },

    add: async (args) => {
      need();
      const t = await cmd("dev_task_add", { ...args, ui: args.ui ?? currentUi() });
      replace(t);
      return t;
    },

    cycleStatus: async (id) => {
      const t = get().tasks.find((x) => x.id === id);
      if (!t) return;
      try {
        need();
        replace(await cmd("dev_task_update", { id, status: nextStatus(t.status) }));
      } catch (e) {
        set({ error: msg(e) });
      }
    },

    cyclePriority: async (id) => {
      const t = get().tasks.find((x) => x.id === id);
      if (!t) return;
      try {
        need();
        replace(await cmd("dev_task_update", { id, priority: nextPriority(t.priority) as DevTaskPriority }));
      } catch (e) {
        set({ error: msg(e) });
      }
    },

    remove: async (id) => {
      try {
        need();
        await cmd("dev_task_delete", { id });
        set((s) => ({ tasks: s.tasks.filter((t) => t.id !== id), error: null }));
      } catch (e) {
        set({ error: msg(e) });
      }
    },

    exportBrief: async () => {
      need();
      set({ exporting: true });
      try {
        const r = await cmd("dev_brief_export");
        set({ lastExport: { path: r.path, at: Date.now() }, error: null });
        return r;
      } finally {
        set({ exporting: false });
      }
    },
  };
});

// Writes from elsewhere (the voice intent) refresh the dock when it's loaded.
if (typeof window !== "undefined") {
  onDevQueueChanged(() => {
    if (useDevQueue.getState().loaded) void useDevQueue.getState().load();
  });
}

export { notifyDevQueueChanged };
