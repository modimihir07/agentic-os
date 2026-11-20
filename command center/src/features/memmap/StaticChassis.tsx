import { ARCH_R, BELT, CAR, doorCuts, frameAt, inArch, sideGlass, sideOutline, stationFrames, tailLamp, type V2 } from "./e46-body";
import { WHEEL } from "./wheel-geometry";

/**
 * A static side-view wireframe of the E46 Touring ("GABAGOUL"), drawn in SVG from the same
 * e46-body geometry as the 3D HoloViewport (side profile spline, arches, greenhouse with the
 * Hofmeister kink, door cuts, wheels), so the narrow layout and the 3D fallback match the
 * hologram. It stands in for the 3D view below `md` and while the 3D chunk loads, or when
 * WebGL is unavailable. Purely decorative: no animation, no loop. Paths are built once at
 * module load.
 */

const K = 92;
const X0 = 240;
const GROUND = 170;
const px = (x: number) => X0 + x * K;
const py = (y: number) => GROUND - y * K;
const pt = ([x, y]: V2) => `${px(x).toFixed(1)} ${py(y).toFixed(1)}`;
const path = (pts: readonly V2[], closed = false) => (pts.length ? `M${pts.map(pt).join("L")}${closed ? "Z" : ""}` : "");

/** Split a polyline wherever it enters a wheel arch. */
function clipArches(pts: readonly V2[]): V2[][] {
  const out: V2[][] = [];
  let run: V2[] = [];
  for (const p of pts) {
    if (inArch(p[0], p[1], ARCH_R - 1e-3)) {
      if (run.length > 1) out.push(run);
      run = [];
    } else run.push(p);
  }
  if (run.length > 1) out.push(run);
  return out;
}

const frames = stationFrames();
const glass = sideGlass();
const lamp = tailLamp(1).flank.map(([x, y]) => [x, y] as V2);

const D = {
  body: path(sideOutline(), true),
  glass: [glass.front, glass.rear, glass.quarter].map((g) => path(g, true)).join(""),
  belt: path(frames.filter((f) => f.yEdge > BELT + 0.02).map((f) => [f.x, BELT] as V2)),
  shoulder: clipArches(frames.map((f) => [f.x, Math.min(0.855, f.yEdge)] as V2))
    .map((r) => path(r))
    .join(""),
  rocker: clipArches(frames.map((f) => [f.x, f.yFloor + 0.06] as V2))
    .map((r) => path(r))
    .join(""),
  doors: doorCuts()
    .map((c) => path(c))
    .join(""),
  rail: path(
    Array.from({ length: 13 }, (_, k) => {
      const x = 0.12 - (2.02 * k) / 12;
      return [x, frameAt(x).yTop + 0.045] as V2;
    }),
  ),
  tail: path(lamp, true),
  head: path(
    [
      [2.12, 0.735],
      [2.215, 0.72],
      [2.235, 0.64],
      [2.15, 0.625],
    ],
    true,
  ),
};

const WHEELS = [CAR.rearAxle, CAR.frontAxle].map((x) => ({ cx: px(x), cy: py(CAR.wheelRadius) }));
const SPOKES = Array.from({ length: 10 }, (_, i) => {
  const a = Math.PI / 2 + Math.floor(i / 2) * ((2 * Math.PI) / 5) + (i % 2 ? 0.17 : -0.17);
  return [Math.cos(a), Math.sin(a)] as const;
});

export function StaticChassis({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 480 200" className={className} role="img" aria-label="Wireframe of the E46 Touring, plate GABAGOUL">
      <defs>
        <filter id="memmap-glow" x="-10%" y="-10%" width="120%" height="120%">
          <feGaussianBlur stdDeviation="2.2" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        <pattern id="memmap-grid" width="16" height="16" patternUnits="userSpaceOnUse">
          <path d="M16 0H0V16" fill="none" stroke="#00d2ff" strokeOpacity="0.07" strokeWidth="0.6" />
        </pattern>
      </defs>
      <rect width="480" height="200" fill="url(#memmap-grid)" />
      <line x1="20" y1={GROUND} x2="460" y2={GROUND} stroke="#00d2ff" strokeOpacity="0.25" strokeDasharray="2 4" />
      <g fill="none" stroke="#00d2ff" strokeWidth="1.2" strokeLinejoin="round" strokeLinecap="round" filter="url(#memmap-glow)">
        {/* Body: the side profile spline over the long wagon roof, sill and both arches. */}
        <path d={D.body} />
        {/* Greenhouse: front door, rear door, quarter glass with the Hofmeister kink. */}
        <path d={D.glass} strokeOpacity="0.8" />
        <path d={D.belt} strokeOpacity="0.6" />
        {/* Shoulder crease, rocker, door cuts, roof rail. */}
        <path d={D.shoulder} strokeOpacity="0.45" />
        <path d={D.rocker} strokeOpacity="0.3" />
        <path d={D.doors} strokeOpacity="0.35" />
        <path d={D.rail} strokeOpacity="0.6" />
        {/* Lamps. */}
        <path d={D.tail} stroke="#f59e0b" strokeOpacity="0.9" />
        <path d={D.head} strokeOpacity="0.9" />
        {/* 18-inch wheels: tyre, rim lip, twin spokes, rotor. */}
        {WHEELS.map(({ cx, cy }) => (
          <g key={cx}>
            <circle cx={cx} cy={cy} r={WHEEL.tyreR * K} />
            <circle cx={cx} cy={cy} r={WHEEL.rimR * K} strokeOpacity="0.7" />
            <circle cx={cx} cy={cy} r={WHEEL.rotorR * K} strokeOpacity="0.3" />
            <circle cx={cx} cy={cy} r={WHEEL.hubR * K} strokeOpacity="0.6" />
            <path
              d={SPOKES.map(([c, s]) => `M${(cx + c * WHEEL.hubR * K).toFixed(1)} ${(cy - s * WHEEL.hubR * K).toFixed(1)}L${(cx + c * 0.21 * K).toFixed(1)} ${(cy - s * 0.21 * K).toFixed(1)}`).join("")}
              strokeOpacity="0.55"
              strokeWidth="0.8"
            />
          </g>
        ))}
      </g>
      <g>
        <rect x="200" y="176" width="80" height="18" rx="3" fill="#06080c" stroke="#f59e0b" strokeOpacity="0.8" />
        <text x="240" y="189" textAnchor="middle" fontFamily="JetBrains Mono Variable, monospace" fontSize="10" fontWeight="700" letterSpacing="1.5" fill="#f59e0b">
          GABAGOUL
        </text>
      </g>
    </svg>
  );
}
