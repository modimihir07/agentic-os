import { useEffect, useMemo, useRef, useState, type ComponentRef, type MutableRefObject, type RefObject } from "react";
import { Canvas, useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { Line, OrbitControls } from "@react-three/drei";
import { AdditiveBlending, BoxGeometry, BufferGeometry, CanvasTexture, Color, DoubleSide, EdgesGeometry, Float32BufferAttribute, ShaderMaterial, SRGBColorSpace, Vector3 } from "three";
import type { Group, Mesh, MeshBasicMaterial, PerspectiveCamera } from "three";
import type { TraceZone } from "@/lib/platform";
import { usePrefersReducedMotion } from "@/lib/use-media-query";
import { useTrace } from "./trace-store";
import { useZoneUi } from "./zone-store";
import { e46Wireframe, fitDistance, freshSteps, HOLO_CAMERA, HOLO_FOV, HOLO_TARGET, leaderElbow, pedestal, platePoint, pointAt, PULSE_MS, pulseCurve, pulsesFor, rearPlate, sweepFan, TELEMETRY_NODES, WHEELS_LABEL, ZONE_VOLUMES, zoneAnchor, zoneFlash, type Rect, type V3, type ZoneVolume } from "./holo-geometry";

/**
 * HOLO VIEWPORT (plan §3): a procedural 2004 E46 325i Touring (facelift, M-Tech bumper,
 * coilover stance) as a glowing holographic blueprint — Orient Blue body lines, cyan
 * glass/wheels/lamps, angel eyes in their own brighter group with a glow pass, amber tail
 * lamps and exhaust, a dim cyan x-ray of the chassis and drivetrain inside, and a "GABAGOUL"
 * rear plate drawn into a CanvasTexture (no asset, nothing fetched). It stands on a glowing
 * pedestal: a clipped tech grid, rim rings, radial ticks and a scanning sweep.
 *
 * Depth: the lofted body skin is drawn depth-only first (colorWrite off, polygon offset), so
 * the far side's lines are hidden behind the near side; a faint pass of the same lines with
 * depthTest off keeps them as a ghost, and a Fresnel rim lights the silhouette. The x-ray
 * chassis, zone glows and pulses ignore depth so they stay visible through the skin.
 *
 * - Auto-rotates ~6°/s; drag to orbit (rotation resumes 4 s after release).
 * - `frameloop="demand"` + a 30 fps interval that only runs while the window is visible
 *   and the canvas is on screen. Under prefers-reduced-motion: no interval, no pulses —
 *   a single static frame that re-renders only on hover/drag.
 * - Five invisible zone hit volumes (hood, firewall, cabin, hatch, tailpipe): hover glows
 *   the zone, click opens its ZoneInspector.
 * - PulseLayer: each new trace step sends a dot along an arc from the previous step's zone
 *   to its own (`useTrace`), flashing the zone on arrival.
 * - Elbowed leader lines from the callout cards (`[data-zone]` in `stage`) to node rings at
 *   the projected zone anchors, plus a WHEELS pin on whichever wheel faces the camera (a
 *   label only: no card, no inspector, not a trace zone). Updated per frame straight on the
 *   SVG (no React re-render, no per-frame allocation beyond the attribute strings).
 */

// The car's own palette (the System Map cards keep --color-holo / --color-ember).
const CYAN = "#00f0ff";
const AMBER = "#ffaa00";
const ALERT = "#ff5a5f";
/** BMW Orient Blue, lifted so it reads as light on the carbon background. */
const ORIENT = "#3a64b8";
/** The x-ray chassis layer: a dimmer, deeper cyan. */
const XRAY = "#0b8fb0";
/** Radar sweep speed over the pedestal (radians per second). */
const SWEEP = 0.9;
/** ~6° per second. */
const SPIN = (6 * Math.PI) / 180;
const FRAME_MS = 1000 / 30;
const RESUME_MS = 4000;
const MAX_PULSES = 16;
/** A pulse's travel + its trail's fade. */
const PULSE_LIFE = PULSE_MS + 650;
/** The wheels pin: how far its label sits up and out from the hub, and where the leader bends (px). */
const PIN_RISE = 40;
const PIN_ELBOW = 28;
const PIN_RUN = 40;
/** The car starts 3/4 from the rear (camera behind and to the right). */
const CAMERA: V3 = HOLO_CAMERA;
const TARGET: V3 = HOLO_TARGET;
const CALLOUT_ZONES: TraceZone[] = ["engine", "cargo", "cockpit", "exhaust"];
const FOV = HOLO_FOV;

/** Zone flashes when a pulse arrives: zone → {at (performance.now ms), ok}. Shared by the
 * pulse layer (writer) and the zone boxes (readers, per frame). */
const flashes = new Map<TraceZone, { at: number; ok: boolean }>();
/** Preallocated so the per-frame flash path copies colours instead of re-parsing hex strings. */
const C_CYAN = new Color(CYAN);
const C_AMBER = new Color(AMBER);
const C_ALERT = new Color(ALERT);

function lineGeometry(segments: number[]): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute("position", new Float32BufferAttribute(segments, 3));
  return g;
}

/** Visible document + canvas on screen (IntersectionObserver). Drives the frame interval. */
function useOnScreen(el: RefObject<HTMLElement | null>): boolean {
  const [visible, setVisible] = useState(() => !document.hidden);
  const [inView, setInView] = useState(true);
  useEffect(() => {
    const onVis = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", onVis);
    let io: IntersectionObserver | undefined;
    if (el.current && typeof IntersectionObserver !== "undefined") {
      io = new IntersectionObserver((entries) => setInView(entries.some((e) => e.isIntersecting)));
      io.observe(el.current);
    }
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      io?.disconnect();
    };
  }, [el]);
  return visible && inView;
}

export function HoloViewport({ stage }: { stage: RefObject<HTMLDivElement | null> }) {
  const reduced = usePrefersReducedMotion();
  const wrap = useRef<HTMLDivElement>(null);
  const running = useOnScreen(wrap);
  const hovered = useZoneUi((s) => s.hovered);
  const cards = useRef(new Map<TraceZone, Rect>());
  const leaders = useRef(new Map<TraceZone, SVGGElement>());
  const pin = useRef<SVGGElement>(null);
  const invalidate = useRef<() => void>(() => undefined);

  // Callout card rects, relative to the viewport (re-measured whenever the stage or a card resizes).
  useEffect(() => {
    const root = stage.current;
    const box = wrap.current;
    if (!root || !box || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const base = box.getBoundingClientRect();
      cards.current.clear();
      root.querySelectorAll<HTMLElement>("[data-zone]").forEach((el) => {
        const z = el.dataset.zone as TraceZone;
        const r = el.getBoundingClientRect();
        if (r.width > 0) cards.current.set(z, { x: r.left - base.left, y: r.top - base.top, w: r.width, h: r.height });
      });
      invalidate.current();
    };
    const ro = new ResizeObserver(measure);
    ro.observe(root);
    root.querySelectorAll("[data-zone]").forEach((el) => ro.observe(el));
    measure();
    return () => ro.disconnect();
  }, [stage]);

  return (
    <div
      ref={wrap}
      className="absolute inset-0"
      style={{ cursor: hovered ? "pointer" : "grab" }}
      role="img"
      aria-label="Holographic wireframe of the E46 Touring, plate GABAGOUL. Hover a zone to highlight it, click to inspect it; drag to orbit."
    >
      <Canvas
        frameloop="demand"
        dpr={[1, 2]}
        flat
        camera={{ position: [...CAMERA], fov: FOV, near: 0.1, far: 80 }}
        gl={{ antialias: true, alpha: true }}
        style={{ filter: "drop-shadow(0 0 3px rgba(0,240,255,0.45))" }}
        onPointerMissed={() => useZoneUi.getState().hover(null)}
      >
        <Scene reduced={reduced} running={running} cards={cards} leaders={leaders} pin={pin} invalidateOut={invalidate} />
      </Canvas>
      <svg className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden>
        {CALLOUT_ZONES.map((z) => (
          <g
            key={z}
            ref={(el) => {
              if (el) leaders.current.set(z, el);
              else leaders.current.delete(z);
            }}
            style={{ display: "none" }}
          >
            <polyline fill="none" stroke={CYAN} strokeOpacity={0.45} strokeWidth={1} strokeLinejoin="round" />
            <circle r={4} fill="none" stroke={CYAN} strokeWidth={1} />
            <circle r={2.5} fill={CYAN} />
          </g>
        ))}
        <g ref={pin} style={{ display: "none" }}>
          <polyline fill="none" stroke={CYAN} strokeOpacity={0.55} strokeWidth={1} strokeLinejoin="round" />
          <circle r={4} fill="none" stroke={CYAN} strokeOpacity={0.8} strokeWidth={1} />
          <circle r={1.8} fill={CYAN} />
          <text fill={CYAN} fillOpacity={0.85} fontSize={9.5} letterSpacing={1.2} dominantBaseline="middle" className="font-mono">
            {WHEELS_LABEL}
          </text>
        </g>
      </svg>
    </div>
  );
}

interface SceneProps {
  reduced: boolean;
  running: boolean;
  cards: MutableRefObject<Map<TraceZone, Rect>>;
  leaders: MutableRefObject<Map<TraceZone, SVGGElement>>;
  pin: RefObject<SVGGElement | null>;
  invalidateOut: MutableRefObject<() => void>;
}

function Scene({ reduced, running, cards, leaders, pin, invalidateOut }: SceneProps) {
  const invalidate = useThree((s) => s.invalidate);
  const camera = useThree((s) => s.camera);
  const width = useThree((s) => s.size.width);
  const height = useThree((s) => s.size.height);
  const car = useRef<Group>(null);
  const drag = useRef({ active: false, resumeAt: 0 });
  const tmp = useMemo(() => new Vector3(), []);
  /** The elbow leader's [start, elbow] for the zone being drawn: reused every frame. */
  const elbow = useMemo(() => new Float64Array(4), []);
  const fit = useMemo(() => fitDistance(FOV, width / Math.max(1, height), { camera: CAMERA, target: TARGET }), [width, height]);

  // Keep the whole car in frame at any stage size (3/4 rear view, along the initial camera ray).
  useEffect(() => {
    const dir = new Vector3(CAMERA[0] - TARGET[0], CAMERA[1] - TARGET[1], CAMERA[2] - TARGET[2]).normalize();
    (camera as PerspectiveCamera).position.set(TARGET[0], TARGET[1], TARGET[2]).addScaledVector(dir, fit);
    camera.lookAt(TARGET[0], TARGET[1], TARGET[2]);
    invalidate();
  }, [camera, fit, invalidate]);

  useEffect(() => {
    invalidateOut.current = () => invalidate();
    return () => {
      invalidateOut.current = () => undefined;
    };
  }, [invalidate, invalidateOut]);

  // The 30 fps clock: only while animating and on screen. Otherwise one frame, then idle.
  useEffect(() => {
    invalidate();
    if (reduced || !running) return;
    const id = setInterval(() => invalidate(), FRAME_MS);
    return () => clearInterval(id);
  }, [reduced, running, invalidate]);

  useFrame((state, dt) => {
    const g = car.current;
    if (!g) return;
    if (!reduced && !drag.current.active && performance.now() >= drag.current.resumeAt) g.rotation.y += Math.min(dt, 0.1) * SPIN;
    g.updateMatrixWorld();
    state.camera.updateMatrixWorld();

    // Leader lines: callout card edge → elbow → node ring at the projected zone anchor.
    const { width, height } = state.size;
    const { hovered, selected } = useZoneUi.getState();
    for (let i = 0; i < CALLOUT_ZONES.length; i++) {
      const z = CALLOUT_ZONES[i];
      const el = leaders.current.get(z);
      if (!el) continue;
      const rect = cards.current.get(z);
      const a = zoneAnchor(z);
      tmp.set(a[0], a[1], a[2]).applyMatrix4(g.matrixWorld).project(state.camera);
      const px = ((tmp.x + 1) / 2) * width;
      const py = ((1 - tmp.y) / 2) * height;
      if (!rect || tmp.z >= 1 || !leaderElbow(rect, px, py, elbow)) {
        el.style.display = "none";
        continue;
      }
      el.style.display = "";
      const hot = hovered === z || selected === z;
      const color = selected === z ? AMBER : CYAN;
      const line = el.children[0];
      const ring = el.children[1];
      const dot = el.children[2];
      line.setAttribute("points", `${elbow[0].toFixed(1)},${elbow[1].toFixed(1)} ${elbow[2].toFixed(1)},${elbow[3].toFixed(1)} ${px.toFixed(1)},${py.toFixed(1)}`);
      line.setAttribute("stroke", color);
      line.setAttribute("stroke-opacity", hot ? "0.9" : "0.4");
      const cx = px.toFixed(1);
      const cy = py.toFixed(1);
      ring.setAttribute("cx", cx);
      ring.setAttribute("cy", cy);
      dot.setAttribute("cx", cx);
      dot.setAttribute("cy", cy);
      ring.setAttribute("stroke", color);
      ring.setAttribute("stroke-opacity", hot ? "0.95" : "0.55");
      dot.setAttribute("fill", color);
    }

    // The WHEELS pin: on the wheel hub nearest the camera (smallest NDC depth), its label up and outward.
    const p = pin.current;
    if (p) {
      let bz = Infinity;
      let bx = 0;
      let by = 0;
      for (let i = 0; i < TELEMETRY_NODES.length; i++) {
        const a = TELEMETRY_NODES[i].anchor;
        tmp.set(a[0], a[1], a[2]).applyMatrix4(g.matrixWorld).project(state.camera);
        if (tmp.z < bz) {
          bz = tmp.z;
          bx = tmp.x;
          by = tmp.y;
        }
      }
      if (bz >= 1 || Math.abs(bx) > 1 || Math.abs(by) > 1) {
        p.style.display = "none";
      } else {
        p.style.display = "";
        const hx = ((bx + 1) / 2) * width;
        const hy = ((1 - by) / 2) * height;
        const dir = hx < width / 2 ? -1 : 1;
        const ly = hy - PIN_RISE;
        p.children[0].setAttribute("points", `${hx.toFixed(1)},${hy.toFixed(1)} ${(hx + dir * PIN_ELBOW).toFixed(1)},${ly.toFixed(1)} ${(hx + dir * PIN_RUN).toFixed(1)},${ly.toFixed(1)}`);
        for (let k = 1; k <= 2; k++) {
          p.children[k].setAttribute("cx", hx.toFixed(1));
          p.children[k].setAttribute("cy", hy.toFixed(1));
        }
        const label = p.children[3];
        label.setAttribute("x", (hx + dir * (PIN_RUN + 4)).toFixed(1));
        label.setAttribute("y", ly.toFixed(1));
        label.setAttribute("text-anchor", dir < 0 ? "end" : "start");
      }
    }
  });

  return (
    <>
      <group ref={car}>
        <CarWire />
        <Plate />
        <Zones />
        {!reduced && <PulseLayer />}
      </group>
      <Pedestal reduced={reduced} />
      <OrbitControls
        makeDefault
        enablePan={false}
        minDistance={fit * 0.6}
        maxDistance={fit * 1.6}
        maxPolarAngle={Math.PI * 0.49}
        target={[...TARGET]}
        onStart={() => {
          drag.current.active = true;
        }}
        onEnd={() => {
          drag.current.active = false;
          drag.current.resumeAt = performance.now() + RESUME_MS;
        }}
      />
    </>
  );
}

/** Never a raycast target: the shell and glow must not swallow zone hovers. */
const noRaycast = () => null;

const FRESNEL_VERT = /* glsl */ `
varying vec3 vN;
varying vec3 vV;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vN = normalize(normalMatrix * normal);
  vV = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}`;

const FRESNEL_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uStrength;
varying vec3 vN;
varying vec3 vV;
void main() {
  float f = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.6);
  gl_FragColor = vec4(uColor, f * uStrength);
  #include <colorspace_fragment>
}`;

function CarWire() {
  const geos = useMemo(() => {
    const w = e46Wireframe();
    const shell = new BufferGeometry();
    if (w.shell) {
      shell.setAttribute("position", new Float32BufferAttribute(w.shell.positions, 3));
      shell.setIndex(w.shell.index);
      shell.computeVertexNormals();
    }
    const halo = w.halo ?? [];
    // The glow pass draws the same rings as fat lines (LineSegments2): point pairs, built once.
    const glow = Array.from({ length: halo.length / 3 }, (_, i) => [halo[3 * i], halo[3 * i + 1], halo[3 * i + 2]] as [number, number, number]);
    return { base: lineGeometry(w.base), cyan: lineGeometry(w.cyan), amber: lineGeometry(w.amber), halo: lineGeometry(halo), inner: lineGeometry(w.inner ?? []), shell, glow };
  }, []);
  const fresnel = useMemo(
    () =>
      new ShaderMaterial({
        uniforms: { uColor: { value: new Color(CYAN) }, uStrength: { value: 0.3 } },
        vertexShader: FRESNEL_VERT,
        fragmentShader: FRESNEL_FRAG,
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
        side: DoubleSide,
        toneMapped: false,
      }),
    [],
  );
  useEffect(
    () => () => {
      for (const g of [geos.base, geos.cyan, geos.amber, geos.halo, geos.inner, geos.shell]) g.dispose();
      fresnel.dispose();
    },
    [geos, fresnel],
  );
  return (
    <>
      {/* Depth-only skin, drawn first and pushed back a hair so on-surface lines never z-fight. */}
      <mesh geometry={geos.shell} renderOrder={-1} raycast={noRaycast}>
        <meshBasicMaterial colorWrite={false} depthWrite side={DoubleSide} polygonOffset polygonOffsetFactor={1} polygonOffsetUnits={1} />
      </mesh>
      {/* Faint Fresnel rim on the nearest surface. */}
      <mesh geometry={geos.shell} material={fresnel} raycast={noRaycast} />
      {/* Ghost pass: the hidden far side, very faint. */}
      <lineSegments geometry={geos.base} raycast={noRaycast}>
        <lineBasicMaterial color={ORIENT} transparent opacity={0.13} blending={AdditiveBlending} depthWrite={false} depthTest={false} toneMapped={false} />
      </lineSegments>
      <lineSegments geometry={geos.cyan} raycast={noRaycast}>
        <lineBasicMaterial color={CYAN} transparent opacity={0.12} blending={AdditiveBlending} depthWrite={false} depthTest={false} toneMapped={false} />
      </lineSegments>
      {/* X-ray: chassis and drivetrain inside the body. */}
      <lineSegments geometry={geos.inner} raycast={noRaycast}>
        <lineBasicMaterial color={XRAY} transparent opacity={0.42} blending={AdditiveBlending} depthWrite={false} depthTest={false} toneMapped={false} />
      </lineSegments>
      {/* The visible shell lines. */}
      <lineSegments geometry={geos.base} raycast={noRaycast}>
        <lineBasicMaterial color={ORIENT} transparent opacity={0.9} blending={AdditiveBlending} depthWrite={false} toneMapped={false} />
      </lineSegments>
      <lineSegments geometry={geos.cyan} raycast={noRaycast}>
        <lineBasicMaterial color={CYAN} transparent opacity={0.95} blending={AdditiveBlending} depthWrite={false} toneMapped={false} />
      </lineSegments>
      <lineSegments geometry={geos.amber} raycast={noRaycast}>
        <lineBasicMaterial color={AMBER} transparent opacity={0.95} blending={AdditiveBlending} depthWrite={false} toneMapped={false} />
      </lineSegments>
      {/* Angel eyes: full-brightness rings plus a wide, faint additive glow around them. */}
      <lineSegments geometry={geos.halo} raycast={noRaycast}>
        <lineBasicMaterial color={CYAN} transparent opacity={1} blending={AdditiveBlending} depthWrite={false} toneMapped={false} />
      </lineSegments>
      {geos.glow.length > 0 && (
        <Line segments points={geos.glow} color={CYAN} lineWidth={4} transparent opacity={0.3} blending={AdditiveBlending} depthWrite={false} toneMapped={false} raycast={noRaycast} />
      )}
    </>
  );
}

/** The glowing pedestal: tech grid, rim rings, radial ticks and a scanning sweep (still under reduced motion). */
function Pedestal({ reduced }: { reduced: boolean }) {
  const sweep = useRef<Mesh>(null);
  const geos = useMemo(() => {
    const p = pedestal();
    const f = sweepFan();
    const fan = new BufferGeometry();
    fan.setAttribute("position", new Float32BufferAttribute(f.positions, 3));
    fan.setAttribute("color", new Float32BufferAttribute(f.colors, 3));
    fan.setIndex(f.index);
    return { grid: lineGeometry(p.grid), rings: lineGeometry(p.rings), ticks: lineGeometry(p.ticks), fan };
  }, []);
  useEffect(() => () => Object.values(geos).forEach((g) => g.dispose()), [geos]);
  useFrame((_, dt) => {
    if (!reduced && sweep.current) sweep.current.rotation.y -= Math.min(dt, 0.1) * SWEEP;
  });
  return (
    <group position={[0, 0.002, 0]}>
      <lineSegments geometry={geos.grid} raycast={noRaycast}>
        <lineBasicMaterial color={CYAN} transparent opacity={0.09} blending={AdditiveBlending} depthWrite={false} toneMapped={false} />
      </lineSegments>
      <lineSegments geometry={geos.rings} raycast={noRaycast}>
        <lineBasicMaterial color={CYAN} transparent opacity={0.38} blending={AdditiveBlending} depthWrite={false} toneMapped={false} />
      </lineSegments>
      <lineSegments geometry={geos.ticks} raycast={noRaycast}>
        <lineBasicMaterial color={CYAN} transparent opacity={0.5} blending={AdditiveBlending} depthWrite={false} toneMapped={false} />
      </lineSegments>
      <mesh ref={sweep} geometry={geos.fan} rotation={[0, 0.6, 0]} raycast={noRaycast}>
        <meshBasicMaterial color={CYAN} vertexColors transparent opacity={0.22} blending={AdditiveBlending} depthWrite={false} side={DoubleSide} toneMapped={false} />
      </mesh>
    </group>
  );
}

/** Draw the rear plate: a German-style plate with the blue EU band and GABAGOUL. */
function drawPlate(cv: HTMLCanvasElement) {
  const ctx = cv.getContext("2d");
  if (!ctx) return;
  const { width: w, height: h } = cv;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "rgba(6,10,16,0.92)";
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = AMBER;
  ctx.lineWidth = 4;
  ctx.strokeRect(3, 3, w - 6, h - 6);
  ctx.fillStyle = "#1d4ed8";
  ctx.fillRect(6, 6, 34, h - 12);
  ctx.fillStyle = "#e5e7eb";
  ctx.font = "700 22px 'JetBrains Mono Variable', ui-monospace, monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("D", 23, h / 2 + 10);
  ctx.fillStyle = AMBER;
  ctx.font = "800 46px 'JetBrains Mono Variable', ui-monospace, monospace";
  ctx.fillText("GABAGOUL", (w + 40) / 2, h / 2 + 2);
}

function Plate() {
  const invalidate = useThree((s) => s.invalidate);
  const tex = useMemo(() => {
    const cv = document.createElement("canvas");
    cv.width = 512;
    cv.height = 112;
    drawPlate(cv);
    const t = new CanvasTexture(cv);
    t.colorSpace = SRGBColorSpace;
    t.anisotropy = 4;
    return t;
  }, []);
  useEffect(() => {
    let live = true;
    // Redraw once the mono font has loaded (the first draw may have used the fallback).
    void document.fonts?.ready.then(() => {
      if (!live) return;
      drawPlate(tex.image as HTMLCanvasElement);
      tex.needsUpdate = true;
      invalidate();
    });
    return () => {
      live = false;
      tex.dispose();
    };
  }, [tex, invalidate]);
  // On the tailgate panel, a hair outside it, leaning forward with it.
  const plate = useMemo(() => rearPlate(), []);
  return (
    <group position={[...platePoint(plate, 0, 0, 0.007)]} rotation={[0, 0, -plate.lean]}>
      <mesh rotation={[0, -Math.PI / 2, 0]}>
        <planeGeometry args={[plate.w, plate.h]} />
        <meshBasicMaterial map={tex} transparent side={DoubleSide} toneMapped={false} />
      </mesh>
    </group>
  );
}

function Zones() {
  const hovered = useZoneUi((s) => s.hovered);
  const selected = useZoneUi((s) => s.selected);
  return (
    <>
      {ZONE_VOLUMES.map((v) => (
        <ZoneBox key={v.zone} v={v} hot={hovered === v.zone} selected={selected === v.zone} />
      ))}
    </>
  );
}

function ZoneBox({ v, hot, selected }: { v: ZoneVolume; hot: boolean; selected: boolean }) {
  const fill = useRef<MeshBasicMaterial>(null);
  const edges = useMemo(() => {
    const box = new BoxGeometry(...v.size);
    const e = new EdgesGeometry(box);
    box.dispose();
    return e;
  }, [v]);
  useEffect(() => () => edges.dispose(), [edges]);
  const active = hot || selected;
  const color = selected ? AMBER : CYAN;
  const baseOpacity = hot ? 0.09 : selected ? 0.06 : 0;

  // Pulse-arrival flash: a short decaying glow (only fires when the pulse layer runs).
  useFrame(() => {
    const m = fill.current;
    if (!m) return;
    const f = flashes.get(v.zone);
    let flash = 0;
    if (f) {
      const z = zoneFlash(performance.now() - f.at);
      if (z === "done") {
        // Flash finished: prune it and restore the base colour once (no per-frame re-set after).
        flashes.delete(v.zone);
        m.color.copy(selected ? C_AMBER : C_CYAN);
      } else if (z !== "pending") {
        flash = z;
        m.color.copy(f.ok ? (selected ? C_AMBER : C_CYAN) : C_ALERT);
      }
      // "pending": the pulse is still travelling; leave the entry and the colour alone.
    }
    m.opacity = Math.max(baseOpacity, flash);
  });

  const over = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    useZoneUi.getState().hover(v.zone);
  };
  const out = () => {
    if (useZoneUi.getState().hovered === v.zone) useZoneUi.getState().hover(null);
  };
  const click = (e: ThreeEvent<MouseEvent>) => {
    if (e.delta > 4) return; // the end of a drag, not a click
    e.stopPropagation();
    useZoneUi.getState().select(v.zone);
  };

  return (
    <group position={[...v.center]}>
      <mesh onPointerOver={over} onPointerOut={out} onClick={click}>
        <boxGeometry args={[...v.size]} />
        <meshBasicMaterial ref={fill} color={color} transparent opacity={baseOpacity} blending={AdditiveBlending} depthWrite={false} depthTest={false} toneMapped={false} />
      </mesh>
      {active && (
        <lineSegments geometry={edges}>
          <lineBasicMaterial color={color} transparent opacity={selected ? 0.85 : 0.6} depthWrite={false} depthTest={false} toneMapped={false} />
        </lineSegments>
      )}
    </group>
  );
}

// ── Pulses ───────────────────────────────────────────────────────────────────

interface LivePulse {
  id: number;
  from: TraceZone;
  to: TraceZone;
  ok: boolean;
  curve: V3[];
  /** performance.now() when it starts travelling. */
  born: number;
}

let pulseSeq = 0;

function PulseLayer() {
  const [pulses, setPulses] = useState<LivePulse[]>([]);

  useEffect(
    () =>
      useTrace.subscribe((st, prev) => {
        const fresh = freshSteps(st.steps, prev.steps[prev.steps.length - 1]);
        if (!fresh.length) return;
        const now = performance.now();
        const add = pulsesFor(st.steps, fresh).map((p, i) => ({ id: ++pulseSeq, from: p.from, to: p.to, ok: p.ok, curve: pulseCurve(p.from, p.to), born: now + i * 140 }));
        for (const p of add) flashes.set(p.to, { at: p.born + (p.curve.length ? PULSE_MS : 0), ok: p.ok });
        setPulses((cur) => [...cur, ...add].slice(-MAX_PULSES));
      }),
    [],
  );

  useEffect(() => () => flashes.clear(), []);

  useFrame(() => {
    const now = performance.now();
    if (pulses.some((p) => now - p.born > PULSE_LIFE)) setPulses((cur) => cur.filter((p) => now - p.born <= PULSE_LIFE));
  });

  return (
    <>
      {pulses.map((p) => (p.curve.length ? <PulseTrail key={p.id} p={p} /> : null))}
    </>
  );
}

function PulseTrail({ p }: { p: LivePulse }) {
  const dot = useRef<Mesh>(null);
  const halo = useRef<Mesh>(null);
  // drei's Line forwards its ref to the Line2 object; only its material's opacity is touched.
  const trail = useRef<ComponentRef<typeof Line>>(null);
  const color = p.ok ? CYAN : ALERT;

  useFrame(() => {
    const t = (performance.now() - p.born) / PULSE_MS;
    const travelling = t >= 0 && t <= 1;
    const eased = t <= 0 ? 0 : t >= 1 ? 1 : 1 - (1 - t) * (1 - t);
    const at = pointAt(p.curve, eased);
    for (const m of [dot.current, halo.current]) {
      if (!m) continue;
      m.visible = travelling && at != null;
      if (at) m.position.set(at[0], at[1], at[2]);
    }
    if (trail.current) {
      const fade = t < 0 ? 0 : t <= 1 ? 0.55 : Math.max(0, 0.55 * (1 - (t - 1) / ((PULSE_LIFE - PULSE_MS) / PULSE_MS)));
      trail.current.material.opacity = fade;
    }
  });

  return (
    <>
      <Line
        ref={trail}
        points={p.curve as unknown as [number, number, number][]}
        color={color}
        lineWidth={2}
        transparent
        opacity={0}
        depthWrite={false}
        depthTest={false}
        toneMapped={false}
      />
      <mesh ref={dot} visible={false}>
        <sphereGeometry args={[0.05, 10, 8]} />
        <meshBasicMaterial color={color} depthTest={false} toneMapped={false} />
      </mesh>
      <mesh ref={halo} visible={false}>
        <sphereGeometry args={[0.14, 12, 8]} />
        <meshBasicMaterial color={color} transparent opacity={0.25} blending={AdditiveBlending} depthWrite={false} depthTest={false} toneMapped={false} />
      </mesh>
    </>
  );
}
