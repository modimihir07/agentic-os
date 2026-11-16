import { Component, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { GripVertical, Maximize2, X } from "lucide-react";
import { getWidget } from "./registry";
import { GRID_COLS, GRID_ROWS, fits, useLayout } from "./layout-store";
import type { WidgetInstance } from "./types";
import { useMediaQuery } from "@/lib/use-media-query";

/**
 * 12×8 snap grid on desktop/tablet; a single scrolling column on phones.
 * Empty cells are intentional — they let the wallpaper breathe.
 * In edit mode, drag the grip to move and the corner to resize (pointer events,
 * so it works with mouse and touch).
 */
export function WidgetGrid() {
  const instances = useLayout((s) => s.instances);
  const editing = useLayout((s) => s.editing);
  const compact = useMediaQuery("(max-width: 767px)");
  const gridRef = useRef<HTMLDivElement>(null);

  if (compact) {
    const order = (i: WidgetInstance) => getWidget(i.widgetId)?.compactOrder ?? i.row;
    const ordered = [...instances].sort((a, b) => order(a) - order(b) || a.col - b.col);
    return (
      <div className="flex flex-col gap-3 px-4 pb-40 pt-2">
        {ordered.map((inst) => (
          <WidgetCell key={inst.instanceId} inst={inst} editing={editing} compact />
        ))}
      </div>
    );
  }

  return (
    <div
      ref={gridRef}
      className="relative grid h-full gap-4 px-6 pb-4 xl:gap-5 xl:px-8"
      style={{ gridTemplateColumns: `repeat(${GRID_COLS}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${GRID_ROWS}, minmax(0, 1fr))` }}
    >
      {editing && <GridGuides />}
      {instances.map((inst) => (
        <WidgetCell key={inst.instanceId} inst={inst} editing={editing} gridRef={gridRef} />
      ))}
    </div>
  );
}

function GridGuides() {
  return (
    <>
      {Array.from({ length: GRID_COLS * GRID_ROWS }, (_, i) => (
        <div
          key={i}
          aria-hidden
          className="pointer-events-none rounded-[14px] border border-dashed border-white/[0.07]"
          style={{ gridColumn: (i % GRID_COLS) + 1, gridRow: Math.floor(i / GRID_COLS) + 1 }}
        />
      ))}
    </>
  );
}

type DragMode = "move" | "resize";

function WidgetCell({
  inst,
  editing,
  compact,
  gridRef,
}: {
  inst: WidgetInstance;
  editing: boolean;
  compact?: boolean;
  gridRef?: React.RefObject<HTMLDivElement | null>;
}) {
  const def = getWidget(inst.widgetId);
  const { place, remove, setConfig } = useLayout.getState();
  const [ghost, setGhost] = useState<Pick<WidgetInstance, "col" | "row" | "w" | "h"> | null>(null);
  const [ghostValid, setGhostValid] = useState(true);
  const drag = useRef<{ mode: DragMode; startX: number; startY: number; cellW: number; cellH: number } | null>(null);

  const onPointerDown = useCallback(
    (mode: DragMode) => (e: React.PointerEvent) => {
      const grid = gridRef?.current;
      if (!grid) return;
      e.preventDefault();
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      const rect = grid.getBoundingClientRect();
      drag.current = { mode, startX: e.clientX, startY: e.clientY, cellW: rect.width / GRID_COLS, cellH: rect.height / GRID_ROWS };
    },
    [gridRef],
  );

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dc = Math.round((e.clientX - d.startX) / d.cellW);
    const dr = Math.round((e.clientY - d.startY) / d.cellH);
    const min = def?.minSize ?? { w: 2, h: 1 };
    const max = def?.maxSize ?? { w: GRID_COLS, h: GRID_ROWS };
    const next =
      d.mode === "move"
        ? { col: inst.col + dc, row: inst.row + dr, w: inst.w, h: inst.h }
        : {
            col: inst.col,
            row: inst.row,
            w: Math.min(max.w, Math.max(min.w, inst.w + dc)),
            h: Math.min(max.h, Math.max(min.h, inst.h + dr)),
          };
    setGhost(next);
    setGhostValid(fits(useLayout.getState().instances, { ...inst, ...next }));
  };

  const onPointerUp = () => {
    if (ghost) place(inst.instanceId, ghost);
    drag.current = null;
    setGhost(null);
  };

  useEffect(() => {
    if (!editing) setGhost(null);
  }, [editing]);

  if (!def) {
    return (
      <div className="glass rounded-[14px] p-4 text-sm text-ink-2" style={compact ? undefined : area(inst)}>
        Missing widget “{inst.widgetId}”.{" "}
        <button className="text-amber underline" onClick={() => remove(inst.instanceId)}>
          Remove
        </button>
      </div>
    );
  }

  const Widget = def.component;
  const body = (
    <WidgetBoundary name={def.title}>
      <Suspense fallback={<div className="h-full animate-pulse rounded-[14px] bg-white/[0.03]" />}>
        <Widget
          instanceId={inst.instanceId}
          config={{ ...def.defaultConfig, ...inst.config }}
          setConfig={(patch) => setConfig(inst.instanceId, patch)}
          size={{ w: inst.w, h: inst.h }}
        />
      </Suspense>
    </WidgetBoundary>
  );

  return (
    <>
      {ghost && (
        <div
          aria-hidden
          className={`pointer-events-none z-10 rounded-[20px] border-2 ${ghostValid ? "border-teal/70 bg-teal/10" : "border-alert/70 bg-alert/10"}`}
          style={area(ghost)}
        />
      )}
      <section
        aria-label={def.title}
        className={[
          "relative min-h-0",
          def.chromeless && !editing ? "" : "glass rounded-[20px]",
          compact ? (def.chromeless ? "" : "min-h-40") : "",
          editing ? "ring-1 ring-amber/40" : "",
        ].join(" ")}
        style={compact ? undefined : area(inst)}
      >
        <div className={`h-full ${def.chromeless ? "" : "overflow-auto p-4 xl:p-5"} ${editing ? "pt-11 xl:pt-11" : ""}`}>{body}</div>

        {editing && (
          <>
            <div className="absolute inset-x-2 top-2 z-20 flex items-center justify-between">
              {!compact ? (
                <button
                  aria-label={`Move ${def.title}`}
                  className="well flex cursor-grab touch-none items-center gap-1 rounded-full px-2 py-1 text-ink-2 active:cursor-grabbing"
                  onPointerDown={onPointerDown("move")}
                  onPointerMove={onPointerMove}
                  onPointerUp={onPointerUp}
                  onPointerCancel={onPointerUp}
                >
                  <GripVertical size={14} />
                  <span className="label-caps">{def.title}</span>
                </button>
              ) : (
                <span className="label-caps text-ink-2">{def.title}</span>
              )}
              <button
                aria-label={`Remove ${def.title}`}
                className="well grid size-7 place-items-center rounded-full text-ink-2 hover:text-alert"
                onClick={() => remove(inst.instanceId)}
              >
                <X size={14} />
              </button>
            </div>
            {!compact && (
              <button
                aria-label={`Resize ${def.title}`}
                className="well absolute bottom-2 right-2 z-20 grid size-7 cursor-nwse-resize touch-none place-items-center rounded-full text-ink-2"
                onPointerDown={onPointerDown("resize")}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
              >
                <Maximize2 size={12} className="rotate-90" />
              </button>
            )}
          </>
        )}
      </section>
    </>
  );
}

const area = (r: Pick<WidgetInstance, "col" | "row" | "w" | "h">): React.CSSProperties => ({
  gridColumn: `${r.col} / span ${r.w}`,
  gridRow: `${r.row} / span ${r.h}`,
});

/** One crashing widget shows an inline error instead of blanking the whole board. */
class WidgetBoundary extends Component<{ name: string; children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error) {
    console.error(`[widget:${this.props.name}]`, error);
  }
  render() {
    if (this.state.error)
      return (
        <div className="flex h-full flex-col items-start justify-center gap-2 text-sm">
          <span className="label-caps text-alert">{this.props.name} crashed</span>
          <span className="text-ink-2">{this.state.error.message}</span>
          <button className="pill-glass h-8 text-xs" onClick={() => this.setState({ error: null })}>
            Retry
          </button>
        </div>
      );
    return this.props.children;
  }
}
