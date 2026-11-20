import { Component, lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import { StaticChassis } from "./StaticChassis";
import { ZoneCallouts } from "./ZoneCallouts";
import { GabagoolBlueprint } from "./GabagoolBlueprint";
import { RoutingFlowchart } from "./RoutingFlowchart";

/** Below this stage height the exhaust callout goes compact (no node pills, bottom row).
 * At 420 the tall exhaust card (with pills, ~90 px from max(31%, 8.5rem)) already touched
 * the Gabagool card's top edge, so the switch happens a little earlier. */
const SHORT_STAGE_PX = 460;

/** three.js + R3F + drei live in their own chunk, fetched only when the System Map's
 * desktop layout mounts (never from the main bundle). */
const HoloViewport = lazy(() => import("./HoloViewport").then((m) => ({ default: m.HoloViewport })));

/** The static SVG chassis: the narrow layout, the 3D chunk loading, or WebGL unavailable. */
function ChassisFallback() {
  return (
    <div className="absolute inset-0 grid place-items-center p-[12%_18%]">
      <StaticChassis className="h-full max-h-[340px] w-full max-w-[640px]" />
    </div>
  );
}

/** If WebGL can't start (or the 3D chunk throws), keep the page and show the static chassis. */
class HoloBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: Error) {
    console.warn("[memmap] 3D viewport unavailable, showing the static chassis:", error.message);
  }
  render() {
    return this.state.failed ? <ChassisFallback /> : this.props.children;
  }
}

/** True while the element is shorter than `px` (ResizeObserver). */
function useShorterThan(el: React.RefObject<HTMLElement | null>, px: number, remount: unknown): boolean {
  const [short, setShort] = useState(false);
  useEffect(() => {
    const node = el.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setShort(node.clientHeight < px));
    ro.observe(node);
    return () => ro.disconnect();
  }, [el, px, remount]);
  return short;
}

/**
 * The centre of the System Map. Desktop: the Architecture Routing flowchart strip on top,
 * then the stage — the lazy HoloViewport (three.js) fills it, the zone callouts sit on top
 * with leader lines into the car, and the Gabagool blueprint inset sits bottom-right. The
 * stage keeps a 340 px minimum (the page scrolls instead of crushing the car). Below `md`:
 * the flowchart stacked vertically, the static SVG chassis, the callouts as a list and the
 * blueprint card.
 */
export function CentreStage({ narrow, className = "" }: { narrow: boolean; className?: string }) {
  const stage = useRef<HTMLDivElement>(null);
  const short = useShorterThan(stage, SHORT_STAGE_PX, narrow);
  if (narrow) {
    return (
      <div className={`space-y-2 ${className}`}>
        <RoutingFlowchart orient="v" />
        <div data-slot="viewport" className="rounded-[14px] border border-holo/20 bg-[rgba(4,8,13,0.7)] p-2">
          <StaticChassis className="h-auto w-full" />
        </div>
        <ZoneCallouts layout="stack" />
        <GabagoolBlueprint />
      </div>
    );
  }
  return (
    <div className={`flex min-h-0 flex-col gap-2 ${className}`}>
      <RoutingFlowchart />
      <div
        ref={stage}
        className="@container relative min-h-[340px] flex-1 overflow-hidden rounded-[14px] border border-holo/20 bg-[radial-gradient(ellipse_at_50%_55%,rgba(0,210,255,0.10),rgba(4,8,13,0.55)_65%)]"
      >
        <div data-slot="viewport" className="absolute inset-0">
          <HoloBoundary>
            <Suspense fallback={<ChassisFallback />}>
              <HoloViewport stage={stage} />
            </Suspense>
          </HoloBoundary>
        </div>
        <ZoneCallouts layout="overlay" compact={short} />
        <div className="pointer-events-auto absolute bottom-3 right-3 w-[min(200px,32%)]">
          <GabagoolBlueprint />
        </div>
      </div>
    </div>
  );
}
