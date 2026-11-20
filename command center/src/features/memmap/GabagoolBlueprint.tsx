import { useEffect, useMemo, useRef } from "react";
import { usePrefersReducedMotion } from "@/lib/use-media-query";
import { useSettings } from "@/stores/settings";
import {
  BLUEPRINT_YAW,
  BLUEPRINT_YAW_SWING,
  blueprintFit,
  blueprintModules,
  crankSpeed,
  explodeAt,
  explodePoint,
  project,
  telemetryRows,
  type BlueprintFit,
  type BlueprintModule,
  type ModuleId,
  type P2,
  type P3,
  type TelemetryRow,
} from "./blueprint-geometry";
import { frameDue } from "./format";
import { useTrace } from "./trace-store";
import { useMemmap } from "./use-memmap-data";

/**
 * GABAGOOL BLUEPRINT // SUB-COMPONENT callout: a bordered holographic box with an exploded
 * technical wireframe of the 325i's M54B25 inline-six — the cylinder bank with its pistons
 * running, the intake manifold lifted off, the exhaust headers pulled out, the drivetrain
 * slid back — drawn on a 2D canvas (no second WebGL context), with live telemetry rows
 * under it: CPU %, GPU util, VRAM % and tokens/s (or the last model hop's latency). Values
 * come only from the shared System Map snapshot (`useMemmap`, read-only: this card never
 * starts polling) and the trace ring; a missing source shows "—". CPU load drives the crank
 * speed and each row's load brightens its module.
 *
 * 30 fps cap; paused while the window is hidden or the card is off screen; a single static
 * frame (fully exploded) under prefers-reduced-motion, repainted when the telemetry changes.
 * The X-RAY / OS chip keeps the old card's job: switching `systemMapMode`.
 */

const FRAME_MS = 1000 / 30;
const PITCH = 0.42;

const MODULE_RGB: Record<ModuleId, string> = {
  pistons: "0,210,255",
  intake: "120,230,255",
  exhaust: "245,158,11",
  drivetrain: "90,140,235",
};

function brackets(ctx: CanvasRenderingContext2D, w: number, h: number) {
  const L = 7;
  ctx.strokeStyle = "rgba(0,210,255,0.55)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const [x, y, dx, dy] of [
    [1.5, 1.5, 1, 1],
    [w - 1.5, 1.5, -1, 1],
    [1.5, h - 1.5, 1, -1],
    [w - 1.5, h - 1.5, -1, -1],
  ]) {
    ctx.moveTo(x + dx * L, y);
    ctx.lineTo(x, y);
    ctx.lineTo(x, y + dy * L);
  }
  ctx.stroke();
}

function draw(ctx: CanvasRenderingContext2D, w: number, h: number, dpr: number, fit: BlueprintFit, mods: readonly BlueprintModule[], yaw: number, e: number, rows: readonly TelemetryRow[]) {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "rgba(3,18,38,0.9)";
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = "rgba(0,210,255,0.07)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0.5; x < w; x += 10) {
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
  }
  for (let y = 0.5; y < h; y += 10) {
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
  }
  ctx.stroke();
  brackets(ctx, w, h);

  // One fixed fit per box size (computed on resize), so nothing re-scales as the modules move.
  const { scale, cx, cy } = fit;
  const pt = (p: P3): P2 => project(p, yaw, PITCH, scale, cx, cy);
  // The same projection inlined for the bulk of the points: no per-point tuples.
  const cyw = Math.cos(yaw);
  const syw = Math.sin(yaw);
  const cp = Math.cos(PITCH);
  const sp = Math.sin(PITCH);
  const load = new Map(rows.map((r) => [r.module, r.pct]));

  for (const m of mods) {
    const share = load.get(m.id);
    const alpha = share == null ? 0.6 : 0.45 + 0.5 * (share / 100);
    // Guide line from the exploded module back to where it sits on the block.
    if (m.explode.some((v) => v !== 0)) {
      const a = pt(m.anchor);
      const b = pt(explodePoint(m.anchor, m, e));
      ctx.setLineDash([2, 3]);
      ctx.strokeStyle = "rgba(0,210,255,0.35)";
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.strokeStyle = `rgba(${MODULE_RGB[m.id]},${alpha.toFixed(2)})`;
    ctx.lineWidth = 0.9;
    ctx.beginPath();
    const ex = m.explode[0] * e;
    const ey = m.explode[1] * e;
    const ez = m.explode[2] * e;
    for (const l of m.lines) {
      for (let i = 0; i < l.length; i++) {
        const x = l[i][0] + ex;
        const y = l[i][1] + ey;
        const z = l[i][2] + ez;
        const x1 = x * cyw + z * syw;
        const z1 = -x * syw + z * cyw;
        const sx = cx + x1 * scale;
        const sy = cy - (y * cp - z1 * sp) * scale;
        if (i === 0) ctx.moveTo(sx, sy);
        else ctx.lineTo(sx, sy);
      }
    }
    ctx.stroke();
  }
  // Module labels.
  ctx.font = "600 7px 'JetBrains Mono Variable', ui-monospace, monospace";
  ctx.textBaseline = "middle";
  for (const m of mods) {
    const [x, y] = pt(explodePoint(m.anchor, m, e));
    ctx.fillStyle = `rgba(${MODULE_RGB[m.id]},0.9)`;
    ctx.textAlign = x > w / 2 ? "right" : "left";
    ctx.fillText(m.label, Math.max(4, Math.min(w - 4, x + (x > w / 2 ? -4 : 4))), Math.max(6, Math.min(h - 6, y - 5)));
  }
  ctx.textAlign = "left";
  ctx.fillStyle = "rgba(0,210,255,0.6)";
  ctx.textBaseline = "top";
  ctx.fillText("EXPLODED · M54B25", 6, 4);
}

export function GabagoolBlueprint({ className = "" }: { className?: string }) {
  const mode = useSettings((s) => s.systemMapMode);
  const setSettings = useSettings((s) => s.set);
  const reduced = usePrefersReducedMotion();
  const summary = useMemmap((s) => s.snap?.summary ?? null);
  const steps = useTrace((s) => s.steps);
  const rows = useMemo(() => telemetryRows(summary, steps), [summary, steps]);
  const canvas = useRef<HTMLCanvasElement>(null);
  const live = useRef<{ rows: readonly TelemetryRow[]; repaint: () => void }>({ rows, repaint: () => undefined });
  const xray = mode === "xray";

  useEffect(() => {
    const cv = canvas.current;
    const ctx = cv?.getContext("2d");
    if (!cv || !ctx) return;
    let dpr = 1;
    let w = 0;
    let h = 0;
    let fit: BlueprintFit = { scale: 1, cx: 0, cy: 0 };
    let theta = 0;
    let t = 0;
    let raf = 0;
    let last = 0;
    let inView = true;

    const paint = () => {
      const e = reduced ? 1 : explodeAt(t);
      const yaw = reduced ? BLUEPRINT_YAW : BLUEPRINT_YAW + BLUEPRINT_YAW_SWING * Math.sin(t * 0.22);
      draw(ctx, w, h, dpr, fit, blueprintModules(theta), yaw, e, live.current.rows);
    };
    const size = () => {
      // Re-read the pixel ratio every time: a move to another monitor or a zoom changes it.
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = cv.clientWidth;
      h = cv.clientHeight;
      cv.width = Math.max(1, Math.round(w * dpr));
      cv.height = Math.max(1, Math.round(h * dpr));
      fit = blueprintFit(w, h, PITCH, reduced);
      paint();
    };
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      if (!frameDue(now, last, FRAME_MS)) return;
      const dt = last ? Math.min(now - last, 100) / 1000 : 0;
      last = now;
      t += dt;
      const cpu = live.current.rows.find((r) => r.key === "cpu")?.pct;
      theta = (theta + dt * crankSpeed(cpu)) % (Math.PI * 2);
      paint();
    };
    const start = () => {
      if (reduced || raf || document.hidden || !inView) return;
      last = 0;
      raf = requestAnimationFrame(tick);
    };
    const stop = () => {
      cancelAnimationFrame(raf);
      raf = 0;
    };
    const onVis = () => (document.hidden ? stop() : start());
    live.current.repaint = () => {
      if (!raf && w > 0) paint();
    };

    // A pixel-ratio-only change (window dragged to a monitor with another scale) fires no
    // ResizeObserver; watch the resolution query and re-arm it after each change.
    let mq: MediaQueryList | undefined;
    const onDpr = () => {
      size();
      armDpr();
    };
    const armDpr = () => {
      mq?.removeEventListener("change", onDpr);
      mq = typeof window.matchMedia === "function" ? window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`) : undefined;
      mq?.addEventListener?.("change", onDpr);
    };
    armDpr();

    size();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(size) : undefined;
    ro?.observe(cv);
    const io =
      typeof IntersectionObserver !== "undefined"
        ? new IntersectionObserver((entries) => {
            inView = entries.some((en) => en.isIntersecting);
            if (inView) start();
            else stop();
          })
        : undefined;
    io?.observe(cv);
    document.addEventListener("visibilitychange", onVis);
    start();
    return () => {
      stop();
      live.current.repaint = () => undefined;
      mq?.removeEventListener?.("change", onDpr);
      ro?.disconnect();
      io?.disconnect();
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [reduced]);

  // Hand the loop the latest telemetry; a static frame (reduced motion, or paused) repaints with it.
  useEffect(() => {
    live.current.rows = rows;
    live.current.repaint();
  }, [rows]);

  return (
    <div
      className={`relative block w-full overflow-hidden rounded-[10px] border bg-[rgba(5,9,14,0.86)] text-left shadow-[0_0_18px_-8px_rgba(0,210,255,0.5)] ${xray ? "border-ember/45" : "border-holo/30"} ${className}`}
      title="GABAGOOL BLUEPRINT // exploded M54B25 inline-six with live telemetry"
    >
      <div className="flex items-center justify-between gap-2 border-b border-holo/15 px-2 py-1">
        <p className="label-caps truncate !text-[9px] text-holo">
          Sub-component <span className="text-ink-3">//</span> <span className="normal-case tracking-normal text-ink-3">Gabagool blueprint</span>
        </p>
        <button
          type="button"
          onClick={() => setSettings({ systemMapMode: xray ? "streamlined" : "xray" })}
          aria-pressed={xray}
          title={xray ? "Dev X-Ray: ports, paths, IPC and per-hop ms. Click for Streamlined OS." : "Streamlined OS: status colours and plain words. Click for Dev X-Ray."}
          className={`label-caps shrink-0 rounded-[4px] border px-1 !text-[8px] transition-colors ${xray ? "border-ember/50 text-ember" : "border-holo/30 text-ink-2 hover:border-holo/60 hover:text-holo"}`}
        >
          {xray ? "X-Ray" : "OS"}
        </button>
      </div>
      <canvas ref={canvas} className="block h-[100px] w-full" aria-hidden />
      <dl className="grid grid-cols-2 gap-x-2 gap-y-1 border-t border-holo/15 px-2 py-1.5">
        {rows.map((r) => (
          <div key={r.key} title={r.why} className="min-w-0">
            <div className="flex items-baseline justify-between gap-1">
              <dt className="label-caps !text-[8px] text-ink-3">{r.label}</dt>
              <dd className="font-mono text-[10px] tabular-nums" style={{ color: `rgb(${MODULE_RGB[r.module]})` }}>
                {r.value}
              </dd>
            </div>
            <div className="mt-0.5 h-[2px] w-full bg-holo/10">
              {r.pct != null && <div className="h-full" style={{ width: `${r.pct}%`, background: `rgba(${MODULE_RGB[r.module]},0.8)` }} />}
            </div>
          </div>
        ))}
      </dl>
    </div>
  );
}
