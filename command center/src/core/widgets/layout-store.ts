import { create } from "zustand";
import { persist } from "zustand/middleware";
import { getWidget } from "./registry";
import { isTauri } from "@/lib/platform";
import type { WidgetInstance } from "./types";

export const GRID_COLS = 12;
export const GRID_ROWS = 8;

const PIPELINES_SLOT: WidgetInstance = { instanceId: "n8n", widgetId: "n8n-pipelines", col: 4, row: 4, w: 6, h: 2, config: {} };

/**
 * Default board: widgets hug the edges so the centre-bottom of the wallpaper
 * (where the car sits) stays clear.
 */
const DEFAULT_LAYOUT: WidgetInstance[] = [
  { instanceId: "mantra", widgetId: "mantra", col: 4, row: 1, w: 6, h: 3, config: {} },
  // Voice-first: the docked HUD is anchored centre stage, under the mantra.
  { instanceId: "voice", widgetId: "voice-console", col: 4, row: 6, w: 6, h: 3, config: {} },
  // Left: telemetry, time-critical lists.
  { instanceId: "system", widgetId: "system-stats", col: 1, row: 1, w: 3, h: 2, config: {} },
  { instanceId: "reminders", widgetId: "reminders", col: 1, row: 3, w: 3, h: 3, config: {} },
  { instanceId: "pipeline", widgetId: "pipeline", col: 1, row: 6, w: 3, h: 3, config: {} },
  // Right: live nodes, work, atmosphere.
  { instanceId: "agents", widgetId: "agent-nodes", col: 10, row: 1, w: 3, h: 3, config: {} },
  { instanceId: "contracting", widgetId: "contracting", col: 10, row: 4, w: 3, h: 3, config: {} },
  { instanceId: "weather", widgetId: "weather", col: 10, row: 7, w: 3, h: 2, config: {} },
  // Desktop only (needs the Rust side): live n8n sessions + Drive sync, centre band.
  ...(isTauri() ? [PIPELINES_SLOT] : []),
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
  add: (widgetId: string, config?: Record<string, unknown>) => { ok: boolean; reason?: string };
  remove: (instanceId: string) => void;
  /** Returns false (and changes nothing) if the target rect is out of bounds or collides. */
  place: (instanceId: string, rect: Pick<WidgetInstance, "col" | "row" | "w" | "h">) => boolean;
  setConfig: (instanceId: string, patch: Record<string, unknown>) => void;
  setGlass: (instanceId: string, ultra: boolean) => void;
  setGlassAll: (ultra: boolean) => void;
  reset: () => void;
}

export const useLayout = create<LayoutState>()(
  persist(
    (set, get) => ({
      instances: DEFAULT_LAYOUT,
      editing: false,
      setEditing: (editing) => set({ editing }),
      add: (widgetId, config) => {
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
            config: { ...def.defaultConfig, ...config },
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
      setGlass: (instanceId, ultra) =>
        set((s) => ({ instances: s.instances.map((i) => (i.instanceId === instanceId ? { ...i, glass: ultra ? ("ultra" as const) : undefined } : i)) })),
      setGlassAll: (ultra) => set((s) => ({ instances: s.instances.map((i) => ({ ...i, glass: ultra ? ("ultra" as const) : undefined })) })),
      reset: () => set({ instances: DEFAULT_LAYOUT }),
    }),
    {
      name: "cc.layout",
      version: 4,
      partialize: (s) => ({ instances: s.instances }),
      // v3 ships a new default board (reminders, pipeline, contracting). Start from it,
      // then keep any generated custom widgets from the old board that still fit.
      // v4 adds the n8n Pipelines panel (desktop) to the centre band if it's free.
      migrate: (persisted, version) => {
        const state = persisted as { instances: WidgetInstance[] };
        if (version === 3) {
          const has = state.instances.some((i) => i.widgetId === "n8n-pipelines");
          return isTauri() && !has && fits(state.instances, PIPELINES_SLOT) ? { instances: [...state.instances, PIPELINES_SLOT] } : state;
        }
        if (version >= 4) return state;
        let next = [...DEFAULT_LAYOUT];
        for (const old of state.instances ?? []) {
          if (old.widgetId === "custom" && fits(next, old)) next = [...next, old];
        }
        return { instances: next };
      },
    },
  ),
);
