import { create } from "zustand";
import { persist } from "zustand/middleware";
import { getWidget } from "./registry";
import { isTauri } from "@/lib/platform";
import type { WidgetInstance } from "./types";
import { activeItems, allIds, fits, migrateLayout, moveToPage, nextPageName, placeWidget, removePage, sanitizePages, withUniqueIds, type PagesState } from "./pages";

export { GRID_COLS, GRID_ROWS, activeItems, fits, type LayoutPage } from "./pages";

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

export interface AddResult {
  ok: boolean;
  reason?: string;
  /** The page the widget landed on (it becomes the active page). */
  pageId?: string;
  /** True when no page had room and a new one was made. */
  created?: boolean;
}

interface LayoutState extends PagesState {
  editing: boolean;
  setEditing: (v: boolean) => void;
  /** Lands on the start page (default: active) if it fits, else a later page, else a new page. */
  add: (widgetId: string, config?: Record<string, unknown>, opts?: { pageId?: string }) => AddResult;
  remove: (instanceId: string) => void;
  /** Returns false (and changes nothing) if the target rect is out of bounds or collides. */
  place: (instanceId: string, rect: Pick<WidgetInstance, "col" | "row" | "w" | "h">) => boolean;
  setConfig: (instanceId: string, patch: Record<string, unknown>) => void;
  setGlass: (instanceId: string, ultra: boolean) => void;
  setGlassAll: (ultra: boolean) => void;
  /** Resets the active page only: the first page gets the default board back, any other page is cleared. */
  reset: () => void;
  addPage: (name?: string) => string;
  removePage: (id: string) => void;
  renamePage: (id: string, name: string) => void;
  setActivePage: (id: string) => void;
  moveToPage: (instanceId: string, pageId: string) => boolean;
}

const shortId = () => crypto.randomUUID().slice(0, 6);

export const useLayout = create<LayoutState>()(
  persist(
    (set, get) => {
      /** Replace the active page's items. */
      const updateActive = (fn: (items: WidgetInstance[]) => WidgetInstance[]) =>
        set((s) => ({ pages: s.pages.map((p) => (p.id === s.activePage ? { ...p, items: fn(p.items) } : p)) }));
      return {
        pages: [{ id: "p1", name: "Page 1", items: DEFAULT_LAYOUT }],
        activePage: "p1",
        editing: false,
        setEditing: (editing) => set({ editing }),
        add: (widgetId, config, opts) => {
          const def = getWidget(widgetId);
          if (!def) return { ok: false, reason: "Unknown widget" };
          const sizes = [def.defaultSize, def.minSize].filter((z): z is { w: number; h: number } => !!z);
          const s = get();
          const r = placeWidget(s, { widgetId, sizes, config: { ...def.defaultConfig, ...config }, pageId: opts?.pageId }, shortId);
          if (!r.ok) return { ok: false, reason: r.reason };
          set(r.state);
          return { ok: true, pageId: r.pageId, created: r.created };
        },
        remove: (instanceId) => updateActive((items) => items.filter((i) => i.instanceId !== instanceId)),
        place: (instanceId, rect) => {
          const items = activeItems(get());
          const current = items.find((i) => i.instanceId === instanceId);
          if (!current) return false;
          const next = { ...current, ...rect };
          if (!fits(items, next)) return false;
          updateActive((list) => list.map((i) => (i.instanceId === instanceId ? next : i)));
          return true;
        },
        // By id on whichever page holds it (ids are unique), so a widget's late async save still lands after a page switch.
        setConfig: (instanceId, patch) =>
          set((s) => ({
            pages: s.pages.map((p) =>
              p.items.some((i) => i.instanceId === instanceId)
                ? { ...p, items: p.items.map((i) => (i.instanceId === instanceId ? { ...i, config: { ...i.config, ...patch } } : i)) }
                : p,
            ),
          })),
        setGlass: (instanceId, ultra) =>
          updateActive((items) => items.map((i) => (i.instanceId === instanceId ? { ...i, glass: ultra ? ("ultra" as const) : undefined } : i))),
        setGlassAll: (ultra) => updateActive((items) => items.map((i) => ({ ...i, glass: ultra ? ("ultra" as const) : undefined }))),
        reset: () => {
          const s = get();
          const first = s.pages[0]?.id === s.activePage;
          const others = allIds(s.pages.filter((p) => p.id !== s.activePage));
          updateActive(() => (first ? withUniqueIds(DEFAULT_LAYOUT, others, shortId) : []));
        },
        addPage: (name) => {
          const s = get();
          const ids = new Set(s.pages.map((p) => p.id));
          let id = `p${shortId()}`;
          while (ids.has(id)) id = `p${shortId()}`;
          set({ pages: [...s.pages, { id, name: name?.trim() || nextPageName(s.pages), items: [] }], activePage: id });
          return id;
        },
        removePage: (id) => set((s) => removePage(s, id)),
        renamePage: (id, name) => {
          const n = name.trim().slice(0, 40);
          if (n) set((s) => ({ pages: s.pages.map((p) => (p.id === id ? { ...p, name: n } : p)) }));
        },
        setActivePage: (id) => {
          if (get().pages.some((p) => p.id === id)) set({ activePage: id });
        },
        moveToPage: (instanceId, pageId) => {
          const s = get();
          const inst = s.pages.flatMap((p) => p.items).find((i) => i.instanceId === instanceId);
          const next = moveToPage(s, instanceId, pageId, inst ? getWidget(inst.widgetId)?.minSize : undefined);
          if (!next) return false;
          set(next);
          return true;
        },
      };
    },
    {
      name: "cc.layout",
      version: 5,
      partialize: (s) => ({ pages: s.pages, activePage: s.activePage }),
      migrate: (persisted, version) => migrateLayout(persisted, version, DEFAULT_LAYOUT, isTauri() ? PIPELINES_SLOT : null),
      merge: (persisted, current) => (persisted == null ? current : { ...current, ...sanitizePages(persisted, DEFAULT_LAYOUT) }),
    },
  ),
);
