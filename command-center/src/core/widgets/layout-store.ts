import { create } from "zustand";
import { persist } from "zustand/middleware";
import { getWidget } from "./registry";
import type { WidgetInstance } from "./types";

export const GRID_COLS = 12;
export const GRID_ROWS = 8;

/**
 * Default board: widgets hug the edges so the centre-bottom of the wallpaper
 * (where the car sits) stays clear.
 */
const DEFAULT_LAYOUT: WidgetInstance[] = [
  { instanceId: "mantra", widgetId: "mantra", col: 4, row: 1, w: 6, h: 3, config: {} },
  // Voice-first: the docked HUD is anchored centre stage, under the mantra.
  { instanceId: "voice", widgetId: "voice-console", col: 4, row: 6, w: 6, h: 3, config: {} },
  { instanceId: "system", widgetId: "system-stats", col: 1, row: 1, w: 3, h: 2, config: {} },
  { instanceId: "weather", widgetId: "weather", col: 1, row: 3, w: 3, h: 2, config: {} },
  { instanceId: "notes", widgetId: "quick-notes", col: 1, row: 5, w: 3, h: 3, config: {} },
  { instanceId: "agents", widgetId: "agent-nodes", col: 10, row: 1, w: 3, h: 3, config: {} },
  { instanceId: "streams", widgetId: "data-streams", col: 10, row: 4, w: 3, h: 4, config: {} },
];

const overlaps = (a: Pick<WidgetInstance, "col" | "row" | "w" | "h">, b: Pick<WidgetInstance, "col" | "row" | "w" | "h">) =>
  a.col < b.col + b.w && b.col < a.col + a.w && a.row < b.row + b.h && b.row < a.row + a.h;

const inBounds = (r: Pick<WidgetInstance, "col" | "row" | "w" | "h">) =>
  r.col >= 1 && r.row >= 1 && r.col + r.w - 1 <= GRID_COLS && r.row + r.h - 1 <= GRID_ROWS;

export function fits(instances: WidgetInstance[], candidate: WidgetInstance): boolean {
  return inBounds(candidate) && instances.every((o) => o.instanceId === candidate.instanceId || !overlaps(o, candidate));
}

/** First free slot scanning row-major, or null when the board is full. */
function findSlot(instances: WidgetInstance[], w: number, h: number): { col: number; row: number } | null {
  for (let row = 1; row <= GRID_ROWS - h + 1; row++)
    for (let col = 1; col <= GRID_COLS - w + 1; col++)
      if (fits(instances, { instanceId: "__probe", widgetId: "", col, row, w, h, config: {} })) return { col, row };
  return null;
}

interface LayoutState {
  instances: WidgetInstance[];
  editing: boolean;
  setEditing: (v: boolean) => void;
  add: (widgetId: string) => { ok: boolean; reason?: string };
  remove: (instanceId: string) => void;
  /** Returns false (and changes nothing) if the target rect is out of bounds or collides. */
  place: (instanceId: string, rect: Pick<WidgetInstance, "col" | "row" | "w" | "h">) => boolean;
  setConfig: (instanceId: string, patch: Record<string, unknown>) => void;
  reset: () => void;
}

export const useLayout = create<LayoutState>()(
  persist(
    (set, get) => ({
      instances: DEFAULT_LAYOUT,
      editing: false,
      setEditing: (editing) => set({ editing }),
      add: (widgetId) => {
        const def = getWidget(widgetId);
        if (!def) return { ok: false, reason: "Unknown widget" };
        // Try the preferred size first, then shrink to the minimum.
        for (const size of [def.defaultSize, def.minSize].filter((s): s is { w: number; h: number } => !!s)) {
          const slot = findSlot(get().instances, size.w, size.h);
          if (!slot) continue;
          const instance: WidgetInstance = {
            instanceId: `${widgetId}-${crypto.randomUUID().slice(0, 6)}`,
            widgetId,
            ...slot,
            ...size,
            config: { ...def.defaultConfig },
          };
          set((s) => ({ instances: [...s.instances, instance] }));
          return { ok: true };
        }
        return { ok: false, reason: "No free space — remove or shrink a widget first" };
      },
      remove: (instanceId) => set((s) => ({ instances: s.instances.filter((i) => i.instanceId !== instanceId) })),
      place: (instanceId, rect) => {
        const current = get().instances.find((i) => i.instanceId === instanceId);
        if (!current) return false;
        const next = { ...current, ...rect };
        if (!fits(get().instances, next)) return false;
        set((s) => ({ instances: s.instances.map((i) => (i.instanceId === instanceId ? next : i)) }));
        return true;
      },
      setConfig: (instanceId, patch) =>
        set((s) => ({
          instances: s.instances.map((i) => (i.instanceId === instanceId ? { ...i, config: { ...i.config, ...patch } } : i)),
        })),
      reset: () => set({ instances: DEFAULT_LAYOUT }),
    }),
    {
      name: "cc.layout",
      version: 2,
      partialize: (s) => ({ instances: s.instances }),
      // v1 → v2: dock the Voice Console in existing layouts if its slot is free.
      migrate: (persisted, version) => {
        const state = persisted as { instances: WidgetInstance[] };
        if (version < 2 && !state.instances.some((i) => i.widgetId === "voice-console")) {
          const voice = DEFAULT_LAYOUT.find((i) => i.widgetId === "voice-console")!;
          if (fits(state.instances, voice)) state.instances = [...state.instances, voice];
        }
        return state;
      },
    },
  ),
);
