import type { WidgetInstance } from "./types";

/**
 * Pure layout-page logic (no store, no registry) so it can be unit-tested.
 * A page is one 12×8 board; ids are unique across every page.
 */
export const GRID_COLS = 12;
export const GRID_ROWS = 8;

export interface LayoutPage {
  id: string;
  name: string;
  items: WidgetInstance[];
}

export interface PagesState {
  pages: LayoutPage[];
  activePage: string;
}

type Rect = Pick<WidgetInstance, "col" | "row" | "w" | "h">;
export type Size = { w: number; h: number };

const overlaps = (a: Rect, b: Rect) => a.col < b.col + b.w && b.col < a.col + a.w && a.row < b.row + b.h && b.row < a.row + a.h;

const inBounds = (r: Rect) => r.col >= 1 && r.row >= 1 && r.col + r.w - 1 <= GRID_COLS && r.row + r.h - 1 <= GRID_ROWS;

export function fits(instances: WidgetInstance[], candidate: WidgetInstance): boolean {
  return inBounds(candidate) && instances.every((o) => o.instanceId === candidate.instanceId || !overlaps(o, candidate));
}

/** First free slot scanning row-major, or null when the board is full. */
export function findSlot(instances: WidgetInstance[], w: number, h: number): { col: number; row: number } | null {
  for (let row = 1; row <= GRID_ROWS - h + 1; row++)
    for (let col = 1; col <= GRID_COLS - w + 1; col++)
      if (fits(instances, { instanceId: "__probe", widgetId: "", col, row, w, h, config: {} })) return { col, row };
  return null;
}

const EMPTY: WidgetInstance[] = [];

/** The visible board. Returns the stored array (or one shared empty array), so it is a stable selector. */
export const activeItems = (s: PagesState): WidgetInstance[] => s.pages.find((p) => p.id === s.activePage)?.items ?? EMPTY;

export const allIds = (pages: LayoutPage[]) => new Set(pages.flatMap((p) => p.items.map((i) => i.instanceId)));

/** "Page N" with the smallest N ≥ pages+1 that isn't taken, so names stay unique after removals. */
export function nextPageName(pages: LayoutPage[]): string {
  const taken = new Set(pages.map((p) => p.name));
  let n = pages.length + 1;
  while (taken.has(`Page ${n}`)) n++;
  return `Page ${n}`;
}

const mapPage = (s: PagesState, id: string, fn: (items: WidgetInstance[]) => WidgetInstance[]): LayoutPage[] =>
  s.pages.map((p) => (p.id === id ? { ...p, items: fn(p.items) } : p));

export interface PlaceRequest {
  widgetId: string;
  /** Tried in order (default size, then min size). */
  sizes: Size[];
  config: Record<string, unknown>;
  /** Page to try first; defaults to the active page. */
  pageId?: string;
}

export type PlaceResult = { ok: true; state: PagesState; pageId: string; created: boolean; instanceId: string } | { ok: false; reason: string };

/**
 * Put a widget on the first page with room: the start page, then the pages after it,
 * else a new "Page N" (at 1,1). The page it lands on becomes active.
 */
export function placeWidget(s: PagesState, req: PlaceRequest, newId: () => string): PlaceResult {
  const sizes = req.sizes.filter((z) => inBounds({ col: 1, row: 1, ...z }));
  if (!sizes.length) return { ok: false, reason: "That widget is larger than the whole board" };
  const taken = allIds(s.pages);
  let instanceId = `${req.widgetId}-${newId()}`;
  while (taken.has(instanceId)) instanceId = `${req.widgetId}-${newId()}`;
  const make = (slot: { col: number; row: number }, size: Size): WidgetInstance => ({ instanceId, widgetId: req.widgetId, ...slot, ...size, config: req.config });

  const start = Math.max(0, s.pages.findIndex((p) => p.id === (req.pageId ?? s.activePage)));
  for (const page of s.pages.slice(start)) {
    for (const size of sizes) {
      const slot = findSlot(page.items, size.w, size.h);
      if (!slot) continue;
      const inst = make(slot, size);
      return { ok: true, state: { pages: mapPage(s, page.id, (items) => [...items, inst]), activePage: page.id }, pageId: page.id, created: false, instanceId };
    }
  }
  const pageIds = new Set(s.pages.map((p) => p.id));
  let pageId = `p${newId()}`;
  while (pageIds.has(pageId)) pageId = `p${newId()}`;
  const page: LayoutPage = { id: pageId, name: nextPageName(s.pages), items: [make({ col: 1, row: 1 }, sizes[0])] };
  return { ok: true, state: { pages: [...s.pages, page], activePage: pageId }, pageId, created: true, instanceId };
}

/** Never removes the last page; removing the active page activates its neighbour (next, else previous). */
export function removePage(s: PagesState, id: string): PagesState {
  const idx = s.pages.findIndex((p) => p.id === id);
  if (idx < 0 || s.pages.length <= 1) return s;
  const pages = s.pages.filter((p) => p.id !== id);
  const activePage = s.activePage === id ? pages[Math.min(idx, pages.length - 1)].id : s.activePage;
  return { pages, activePage };
}

/** Move a widget to another page, keeping its size (else `fallback`); null when the target has no room. */
export function moveToPage(s: PagesState, instanceId: string, targetId: string, fallback?: Size): PagesState | null {
  const from = s.pages.find((p) => p.items.some((i) => i.instanceId === instanceId));
  const target = s.pages.find((p) => p.id === targetId);
  if (!from || !target || from.id === target.id) return null;
  const inst = from.items.find((i) => i.instanceId === instanceId)!;
  for (const size of [{ w: inst.w, h: inst.h }, ...(fallback ? [fallback] : [])]) {
    const slot = findSlot(target.items, size.w, size.h);
    if (!slot) continue;
    const moved = { ...inst, ...slot, ...size };
    const pages = s.pages.map((p) =>
      p.id === from.id ? { ...p, items: p.items.filter((i) => i.instanceId !== instanceId) } : p.id === target.id ? { ...p, items: [...p.items, moved] } : p,
    );
    return { pages, activePage: s.activePage };
  }
  return null;
}

/** Re-mint any id another page already uses (e.g. the default board's fixed ids after a move). */
export function withUniqueIds(items: WidgetInstance[], taken: Set<string>, newId: () => string): WidgetInstance[] {
  return items.map((i) => {
    if (!taken.has(i.instanceId)) return i;
    let id = `${i.widgetId}-${newId()}`;
    while (taken.has(id)) id = `${i.widgetId}-${newId()}`;
    return { ...i, instanceId: id };
  });
}

const isInstance = (v: unknown): v is WidgetInstance => {
  const i = v as WidgetInstance;
  return !!i && typeof i.instanceId === "string" && typeof i.widgetId === "string" && [i.col, i.row, i.w, i.h].every(Number.isFinite);
};

/** Rehydration guard: drop malformed pages/items, never return zero pages, keep `activePage` pointing at a real page. */
export function sanitizePages(raw: unknown, defaults: WidgetInstance[]): PagesState {
  const r = raw as Partial<PagesState> | null | undefined;
  const pages = (Array.isArray(r?.pages) ? r.pages : [])
    .filter((p): p is LayoutPage => !!p && typeof p.id === "string" && !!p.id && Array.isArray(p.items))
    .map((p) => ({ id: p.id, name: typeof p.name === "string" && p.name.trim() ? p.name : "Page", items: p.items.filter(isInstance) }));
  if (!pages.length) return { pages: [{ id: "p1", name: "Page 1", items: defaults }], activePage: "p1" };
  const activePage = pages.some((p) => p.id === r?.activePage) ? (r!.activePage as string) : pages[0].id;
  return { pages, activePage };
}

/**
 * Persisted `cc.layout` → the v5 pages shape, from any older version. Zustand calls
 * this once with the stored version, so every branch must end in `{pages, activePage}`.
 * `pipelines` is the desktop-only n8n slot (null on the PWA).
 */
export function migrateLayout(persisted: unknown, version: number, defaults: WidgetInstance[], pipelines: WidgetInstance | null): PagesState {
  if (version >= 5) return sanitizePages(persisted, defaults);
  const old = ((persisted as { instances?: unknown } | null)?.instances ?? []) as WidgetInstance[];
  let instances: WidgetInstance[];
  if (version === 4) instances = old;
  else if (version === 3) {
    // v4 added the n8n Pipelines panel to the centre band when it's free.
    const has = old.some((i) => i.widgetId === "n8n-pipelines");
    instances = pipelines && !has && fits(old, pipelines) ? [...old, pipelines] : old;
  } else {
    // v3 shipped a new default board: start from it, keep generated custom widgets that still fit.
    instances = [...defaults];
    for (const o of old) if (o.widgetId === "custom" && fits(instances, o)) instances = [...instances, o];
  }
  return sanitizePages({ pages: [{ id: "p1", name: "Page 1", items: instances }], activePage: "p1" }, defaults);
}
