import { useEffect, useRef } from "react";
import { useAtmosphere, useWeather, type Atmosphere } from "./weather-store";
import { usePrefersReducedMotion } from "@/lib/use-media-query";

/**
 * "Living weather" particle layer, ported from the Stitch export and made
 * DPR-aware, resize-safe and pausable. Sits between the wallpaper and widgets.
 */
interface P {
  x: number; y: number; vx: number; vy: number;
  r: number; a: number; phase: number; rot: number; vr: number; color: string;
}

const COUNTS: Record<Atmosphere, number> = { clear: 35, autumn: 45, midnight: 60, rain: 140, snow: 100, fog: 18 };
const LEAF = ["#ff7a2f", "#ffb693", "#dfc0b2", "#c284ff", "#e07a1f"];

function spawn(mode: Atmosphere, w: number, h: number): P {
  const rnd = Math.random;
  const base: P = { x: rnd() * w, y: rnd() * h, vx: 0, vy: 0, r: 1, a: 0.5, phase: rnd() * Math.PI * 2, rot: rnd() * 360, vr: 0, color: "#fff" };
  switch (mode) {
    case "snow":
      return { ...base, r: rnd() * 2.2 + 0.6, vy: rnd() * 1.2 + 0.5, vx: rnd() * 0.6 - 0.3, a: rnd() * 0.6 + 0.2 };
    case "autumn":
      return { ...base, x: rnd() * (w + 200) - 100, r: rnd() * 8 + 4, vy: rnd() + 0.5, vx: rnd() * 2 + 0.5, vr: (rnd() - 0.5) * 2.5, color: LEAF[Math.floor(rnd() * LEAF.length)], a: rnd() * 0.6 + 0.3 };
    case "clear":
      return { ...base, r: rnd() * 2 + 0.6, vy: -(rnd() * 0.4 + 0.15), vx: rnd() * 0.6 + 0.1, a: rnd() * 0.5 + 0.2, color: "#ffdbcc" };
    case "midnight":
      return { ...base, y: rnd() * h * 0.75, r: rnd() * 1.6 + 0.4, a: rnd() * 0.7 + 0.2, color: rnd() > 0.6 ? "#75ffe0" : "#ddb7ff" };
    case "rain":
      return { ...base, x: rnd() * (w + 150) - 100, r: rnd() * 20 + 10, vy: rnd() * 12 + 12, vx: rnd() * 3 + 2, a: rnd() * 0.4 + 0.15, color: "#75ffe0" };
    case "fog":
      return { ...base, r: rnd() * 260 + 160, vx: rnd() * 0.25 + 0.05, a: rnd() * 0.05 + 0.03, y: h * 0.35 + rnd() * h * 0.65, color: "#c8d2e0" };
  }
}

export function WeatherCanvas() {
  const ref = useRef<HTMLCanvasElement>(null);
  const mode = useAtmosphere();
  const reduced = usePrefersReducedMotion();
  const refresh = useWeather((s) => s.refresh);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 15 * 60_000);
    return () => clearInterval(t);
  }, [refresh]);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || reduced) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let w = 0, h = 0, raf = 0;
    let parts: P[] = [];
    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = window.innerWidth;
      h = window.innerHeight;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // Fewer particles on phones.
      const n = Math.round(COUNTS[mode] * (w < 768 ? 0.5 : 1));
      parts = Array.from({ length: n }, () => spawn(mode, w, h));
    };
    resize();
    window.addEventListener("resize", resize);

    // 30 fps is plenty for drifting particles and halves the backdrop-blur recompute cost
    // of every glass panel above it (a big part of the WebView2 flicker).
    let last = 0;
    const frame = (ts: number) => {
      if (ts - last < 33) {
        raf = requestAnimationFrame(frame);
        return;
      }
      last = ts;
      ctx.clearRect(0, 0, w, h);
      for (const p of parts) {
        ctx.globalAlpha = p.a;
        switch (mode) {
          case "snow":
            ctx.fillStyle = "#fff";
            ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill();
            p.phase += 0.015; p.y += p.vy; p.x += Math.sin(p.phase) * 0.6 + p.vx;
            if (p.y > h) { p.y = -10; p.x = Math.random() * w; }
            if (p.x > w + 10) p.x = -10; else if (p.x < -10) p.x = w + 10;
            break;
          case "autumn":
            ctx.save(); ctx.translate(p.x, p.y); ctx.rotate((p.rot * Math.PI) / 180); ctx.fillStyle = p.color;
            ctx.beginPath(); ctx.moveTo(0, -p.r); ctx.quadraticCurveTo(p.r * 0.6, 0, 0, p.r); ctx.quadraticCurveTo(-p.r * 0.6, 0, 0, -p.r); ctx.fill(); ctx.restore();
            p.phase += 0.02; p.x += p.vx + Math.sin(p.phase) * 1.2; p.y += p.vy; p.rot += p.vr;
            if (p.y > h + 20 || p.x > w + 60) { p.y = -20; p.x = Math.random() * w * 0.7; }
            break;
          case "clear":
          case "midnight": {
            p.phase += mode === "clear" ? 0.025 : 0.035;
            ctx.globalAlpha = Math.max(0.05, p.a * (0.55 + 0.45 * Math.sin(p.phase)));
            ctx.fillStyle = p.color; ctx.shadowColor = mode === "clear" ? "#ff7a2f" : p.color; ctx.shadowBlur = 5;
            ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill(); ctx.shadowBlur = 0;
            if (mode === "clear") {
              p.y += p.vy; p.x += p.vx;
              if (p.y < -10) { p.y = h + 10; p.x = Math.random() * w; }
              if (p.x > w + 10) p.x = -10;
            }
            break;
          }
          case "rain":
            ctx.strokeStyle = p.color; ctx.lineWidth = 1.1;
            ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x + p.vx * 1.5, p.y + p.r); ctx.stroke();
            p.y += p.vy; p.x += p.vx;
            if (p.y > h) { p.y = -20; p.x = Math.random() * (w + 100) - 50; }
            break;
          case "fog": {
            const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r);
            g.addColorStop(0, p.color); g.addColorStop(1, "transparent");
            ctx.fillStyle = g; ctx.fillRect(p.x - p.r, p.y - p.r, p.r * 2, p.r * 2);
            p.x += p.vx; if (p.x - p.r > w) p.x = -p.r;
            break;
          }
        }
      }
      ctx.globalAlpha = 1;
      raf = requestAnimationFrame(frame);
    };

    const onVis = () => {
      cancelAnimationFrame(raf);
      if (!document.hidden) raf = requestAnimationFrame(frame);
    };
    document.addEventListener("visibilitychange", onVis);
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [mode, reduced]);

  return <canvas ref={ref} aria-hidden className="pointer-events-none fixed inset-0 -z-[5] size-full [backface-visibility:hidden] [transform:translateZ(0)] [contain:strict]" />;
}
