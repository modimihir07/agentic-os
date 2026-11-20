import { describe, expect, it } from "vitest";
import { activeItems, findSlot, migrateLayout, moveToPage, nextPageName, placeWidget, removePage, sanitizePages, withUniqueIds, type PagesState } from "./pages";
import type { WidgetInstance } from "./types";

const inst = (instanceId: string, col: number, row: number, w: number, h: number, widgetId = "x"): WidgetInstance => ({ instanceId, widgetId, col, row, w, h, config: {} });
/** A full 12×8 board in four 6×4 blocks. */
const full = (prefix: string) => [inst(`${prefix}a`, 1, 1, 6, 4), inst(`${prefix}b`, 7, 1, 6, 4), inst(`${prefix}c`, 1, 5, 6, 4), inst(`${prefix}d`, 7, 5, 6, 4)];
const ids = () => {
  let n = 0;
  return () => String(++n).padStart(6, "0");
};
const DEFAULTS = [inst("mantra", 4, 1, 6, 3, "mantra"), inst("voice", 4, 6, 6, 3, "voice-console")];
const PIPES = inst("n8n", 4, 4, 6, 2, "n8n-pipelines");

describe("placeWidget", () => {
  it("lands on the active page when there is room", () => {
    const s: PagesState = { pages: [{ id: "p1", name: "Page 1", items: [] }], activePage: "p1" };
    const r = placeWidget(s, { widgetId: "spotify", sizes: [{ w: 3, h: 3 }], config: {} }, ids());
    expect(r.ok && r.created).toBe(false);
    if (!r.ok) throw new Error();
    expect(r.pageId).toBe("p1");
    expect(activeItems(r.state)).toMatchObject([{ widgetId: "spotify", col: 1, row: 1, w: 3, h: 3 }]);
  });

  it("falls back to the min size before leaving the page", () => {
    const s: PagesState = { pages: [{ id: "p1", name: "Page 1", items: [inst("big", 1, 1, 12, 6)] }], activePage: "p1" };
    const r = placeWidget(s, { widgetId: "w", sizes: [{ w: 3, h: 3 }, { w: 3, h: 2 }], config: {} }, ids());
    expect(r.ok && r.pageId).toBe("p1");
    expect(r.ok && activeItems(r.state).at(-1)).toMatchObject({ row: 7, h: 2 });
  });

  it("overflows to a later page, then to a new page, and switches to it", () => {
    const s: PagesState = {
      pages: [
        { id: "p1", name: "Page 1", items: full("a") },
        { id: "p2", name: "Page 2", items: [] },
      ],
      activePage: "p1",
    };
    const r = placeWidget(s, { widgetId: "w", sizes: [{ w: 3, h: 3 }], config: {} }, ids());
    expect(r.ok && [r.pageId, r.created, r.state.activePage]).toEqual(["p2", false, "p2"]);

    const both: PagesState = { pages: [s.pages[0], { id: "p2", name: "Page 2", items: full("b") }], activePage: "p1" };
    const r2 = placeWidget(both, { widgetId: "w", sizes: [{ w: 3, h: 3 }], config: { a: 1 } }, ids());
    if (!r2.ok) throw new Error();
    expect(r2.created).toBe(true);
    expect(r2.state.pages).toHaveLength(3);
    expect(r2.state.pages[2]).toMatchObject({ name: "Page 3", items: [{ col: 1, row: 1, w: 3, h: 3, config: { a: 1 } }] });
    expect(r2.state.activePage).toBe(r2.pageId);
  });

  it("does not try pages before the start page", () => {
    const s: PagesState = {
      pages: [
        { id: "p1", name: "Page 1", items: [] },
        { id: "p2", name: "Page 2", items: full("b") },
      ],
      activePage: "p2",
    };
    const r = placeWidget(s, { widgetId: "w", sizes: [{ w: 3, h: 3 }], config: {} }, ids());
    expect(r.ok && r.created).toBe(true);
  });

  it("only refuses a widget larger than the whole board", () => {
    const s: PagesState = { pages: [{ id: "p1", name: "Page 1", items: [] }], activePage: "p1" };
    expect(placeWidget(s, { widgetId: "w", sizes: [{ w: 13, h: 2 }], config: {} }, ids()).ok).toBe(false);
  });

  it("keeps instance ids unique across pages", () => {
    const s: PagesState = {
      pages: [
        { id: "p1", name: "Page 1", items: [inst("w-000001", 1, 1, 2, 2)] },
        { id: "p2", name: "Page 2", items: [inst("w-000002", 1, 1, 2, 2)] },
      ],
      activePage: "p1",
    };
    const r = placeWidget(s, { widgetId: "w", sizes: [{ w: 2, h: 2 }], config: {} }, ids());
    expect(r.ok && r.instanceId).toBe("w-000003");
  });
});

describe("pages", () => {
  const three: PagesState = {
    pages: [
      { id: "a", name: "Page 1", items: [] },
      { id: "b", name: "Page 2", items: [] },
      { id: "c", name: "Page 3", items: [] },
    ],
    activePage: "b",
  };

  it("removePage never removes the last page and falls back to a neighbour", () => {
    expect(removePage(three, "b")).toMatchObject({ activePage: "c" });
    expect(removePage({ ...three, activePage: "c" }, "c").activePage).toBe("b");
    expect(removePage(three, "a").activePage).toBe("b");
    const one: PagesState = { pages: [three.pages[0]], activePage: "a" };
    expect(removePage(one, "a")).toBe(one);
  });

  it("nextPageName stays unique after a removal", () => {
    expect(nextPageName(three.pages)).toBe("Page 4");
    expect(nextPageName([three.pages[0], three.pages[2]])).toBe("Page 4");
    expect(nextPageName([three.pages[0]])).toBe("Page 2");
  });

  it("moveToPage keeps the id and size, or uses the fallback size, or refuses", () => {
    const s: PagesState = {
      pages: [
        { id: "a", name: "Page 1", items: [inst("m", 5, 5, 4, 3)] },
        { id: "b", name: "Page 2", items: [inst("big", 1, 1, 12, 6)] },
      ],
      activePage: "a",
    };
    expect(moveToPage(s, "m", "b")).toBeNull();
    const moved = moveToPage(s, "m", "b", { w: 3, h: 2 })!;
    expect(moved.pages[0].items).toEqual([]);
    expect(moved.pages[1].items.at(-1)).toMatchObject({ instanceId: "m", row: 7, w: 3, h: 2 });
    expect(moveToPage(s, "m", "a")).toBeNull();
  });

  it("findSlot scans row-major", () => {
    expect(findSlot([inst("a", 1, 1, 3, 2)], 3, 2)).toEqual({ col: 4, row: 1 });
    expect(findSlot(full("z"), 1, 1)).toBeNull();
  });

  it("withUniqueIds re-mints only colliding ids", () => {
    const out = withUniqueIds(DEFAULTS, new Set(["voice"]), ids());
    expect(out.map((i) => i.instanceId)).toEqual(["mantra", "voice-console-000001"]);
  });
});

describe("persisted layout", () => {
  it("v4 instances become Page 1", () => {
    const items = [inst("k", 1, 1, 3, 3)];
    expect(migrateLayout({ instances: items }, 4, DEFAULTS, PIPES)).toEqual({ pages: [{ id: "p1", name: "Page 1", items }], activePage: "p1" });
  });

  it("v3 adds the n8n slot when free (desktop), then wraps", () => {
    const out = migrateLayout({ instances: [inst("k", 1, 1, 3, 3)] }, 3, DEFAULTS, PIPES);
    expect(out.pages[0].items.map((i) => i.instanceId)).toEqual(["k", "n8n"]);
    expect(migrateLayout({ instances: [inst("k", 1, 1, 3, 3)] }, 3, DEFAULTS, null).pages[0].items).toHaveLength(1);
  });

  it("v<3 rebuilds from the defaults keeping custom widgets that fit", () => {
    const out = migrateLayout({ instances: [inst("c1", 1, 1, 2, 2, "custom"), inst("c2", 4, 1, 2, 2, "custom"), inst("old", 1, 4, 2, 2, "weather")] }, 2, DEFAULTS, PIPES);
    expect(out.pages[0].items.map((i) => i.instanceId)).toEqual(["mantra", "voice", "c1"]);
    expect(out.activePage).toBe("p1");
  });

  it("v5 and garbage go through the sanitizer", () => {
    const good = { pages: [{ id: "p1", name: "Page 1", items: [] }, { id: "px", name: "Mine", items: [inst("a", 1, 1, 2, 2)] }], activePage: "px" };
    expect(migrateLayout(good, 5, DEFAULTS, PIPES)).toEqual(good);
    expect(sanitizePages({ pages: [] }, DEFAULTS)).toEqual({ pages: [{ id: "p1", name: "Page 1", items: DEFAULTS }], activePage: "p1" });
    expect(sanitizePages(undefined, DEFAULTS).pages[0].items).toBe(DEFAULTS);
    expect(sanitizePages({ pages: [{ id: "", items: [] }, { nope: 1 }] }, DEFAULTS).pages[0].items).toBe(DEFAULTS);
    const fixed = sanitizePages({ pages: [{ id: "q", name: "", items: [inst("a", 1, 1, 2, 2), { bad: true }] }], activePage: "gone" }, DEFAULTS);
    expect(fixed).toEqual({ pages: [{ id: "q", name: "Page", items: [inst("a", 1, 1, 2, 2)] }], activePage: "q" });
  });

  it("activeItems is a stable reference", () => {
    const s: PagesState = { pages: [{ id: "p1", name: "Page 1", items: DEFAULTS }], activePage: "p1" };
    expect(activeItems(s)).toBe(DEFAULTS);
    expect(activeItems({ ...s, activePage: "nope" })).toBe(activeItems({ pages: [], activePage: "x" }));
  });
});
