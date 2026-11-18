import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useMediaQuery } from "@/lib/use-media-query";
import { TopStatusBar } from "@/features/memmap/TopStatusBar";
import { LeftColumn } from "@/features/memmap/LeftColumn";
import { CentreStage } from "@/features/memmap/CentreStage";
import { TraceStream } from "@/features/memmap/TraceStream";
import { IntentNoteBar } from "@/features/memmap/IntentNoteBar";
import { TaskDock } from "@/features/memmap/TaskDock";
import { ZoneInspector } from "@/features/memmap/ZoneInspector";
import { useFlowOpen } from "@/features/memmap/RoutingFlowchart";
import { useZoneUi } from "@/features/memmap/zone-store";

/** Carbon weave under a faint cyan bloom (static CSS, no animation). */
const CARBON: CSSProperties = {
  backgroundColor: "#06080c",
  backgroundImage: [
    "radial-gradient(ellipse at 50% 38%, rgba(0,210,255,0.07), transparent 62%)",
    "repeating-linear-gradient(45deg, rgba(255,255,255,0.016) 0 2px, transparent 2px 4px)",
    "repeating-linear-gradient(-45deg, rgba(0,0,0,0.35) 0 2px, transparent 2px 4px)",
  ].join(","),
};

/**
 * The lg grid's minimum height: top bar + centre (flowchart strip + gap + 340 px stage) +
 * the 220 px dock, gaps and padding. Below it the page scrolls instead of crushing the car.
 */
const MIN_GRID_OPEN = 880;
const MIN_GRID_COLLAPSED = 760;

/** Height of an element (ResizeObserver); 0 until measured. */
function useHeight(el: React.RefObject<HTMLElement | null>): number {
  const [h, setH] = useState(0);
  useEffect(() => {
    const node = el.current;
    if (!node) return;
    setH(node.clientHeight);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setH(node.clientHeight));
    ro.observe(node);
    return () => ro.disconnect();
  }, [el]);
  return h;
}

/**
 * System Map ("architectural X-ray"): how the OS is wired, how data moves through it and
 * why a node succeeds or fails — plus the dev task queue. Plan: docs/memory-map-plan.md.
 *
 * lg+: grid [260 | 1fr | 320] (xl [280 | 1fr | 340]) × [auto | 1fr | 220] — status bar
 * across the top; the OS-state panel, switches and subsystem cards on the left; the routing
 * flowchart over the car in the centre with the future-tasks dock under it; the live trace
 * and the note bar on the right (the zone inspector opens over them). When the window is too
 * short for a 340 px stage the grid takes a fixed height and the page scrolls. Narrower: one
 * scrolling column (below md, the flowchart stacks vertically over a static chassis).
 */
export function MemoryMapSection() {
  const md = useMediaQuery("(min-width: 768px)");
  const lg = useMediaQuery("(min-width: 1024px)");
  const flowOpen = useFlowOpen();
  const page = useRef<HTMLDivElement>(null);
  const height = useHeight(page);
  const minGrid = flowOpen ? MIN_GRID_OPEN : MIN_GRID_COLLAPSED;
  // Fixed-height grid + page scroll when the window can't fit the minimum stage.
  const cramped = lg && height > 0 && height < minGrid;
  // Leave no zone hovered or inspector open behind when the page is left.
  useEffect(() => () => useZoneUi.setState({ hovered: null, selected: null }), []);
  return (
    <div ref={page} className={`h-full w-full overflow-y-auto px-3 pb-32 pt-3 md:px-4 md:pb-4 ${cramped ? "" : "lg:overflow-hidden"}`} style={CARBON}>
      <div
        className="flex flex-col gap-3 lg:grid lg:grid-cols-[260px_minmax(0,1fr)_320px] lg:grid-rows-[auto_minmax(0,1fr)_220px] xl:grid-cols-[280px_minmax(0,1fr)_340px]"
        style={lg ? { height: cramped ? minGrid - 28 : "100%" } : undefined}
      >
        <TopStatusBar className="lg:col-span-3 lg:row-start-1" />
        <CentreStage narrow={!md} className="lg:col-start-2 lg:row-start-2 lg:min-h-0" />
        <div className="relative flex min-h-0 flex-col gap-3 lg:col-start-3 lg:row-span-2 lg:row-start-2">
          <TraceStream className="min-h-[300px] flex-1 lg:min-h-0" />
          <IntentNoteBar />
          {/* Car-zone drill-down: a drawer over this column (a bottom sheet below lg). */}
          <ZoneInspector />
        </div>
        <TaskDock className="min-h-[220px] lg:col-start-2 lg:row-start-3 lg:min-h-0" />
        <LeftColumn className="lg:col-start-1 lg:row-span-2 lg:row-start-2 lg:overflow-y-auto lg:pr-1" />
      </div>
    </div>
  );
}
