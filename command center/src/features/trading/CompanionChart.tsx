import { useEffect, useRef, useState } from "react";
import type { Candle } from "@/lib/cc-api";
import type { Profile, Zone } from "./analysis";

const COL = {
  up: "#00E5C3",
  down: "#FF5A5F",
  demand: "rgba(0,229,195,0.14)",
  demandEdge: "rgba(0,229,195,0.7)",
  supply: "rgba(255,90,95,0.14)",
  supplyEdge: "rgba(255,90,95,0.7)",
  poc: "#FFB36B",
  va: "rgba(255,179,107,0.55)",
  grid: "rgba(255,255,255,0.05)",
  text: "#A1A8B8",
  profile: "rgba(168,85,247,0.35)",
  profileVa: "rgba(168,85,247,0.6)",
};

/**
 * Candles + volume profile + supply/demand zones + POC / value area, on one
 * canvas. The profile histogram sits on the right edge, aligned to the same
 * price scale, so the POC line visibly comes out of its tallest bar.
 */
export function CompanionChart({
  candles,
  profile,
  zones,
  showPoc,
  showZones,
  showValueArea,
  height = 460,
}: {
  candles: Candle[];
  profile: Profile | null;
  zones: Zone[];
  showPoc: boolean;
  showZones: boolean;
  showValueArea: boolean;
  height?: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);
  const [width, setWidth] = useState(800);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx || !candles.length) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const axisW = 64;
    const profW = Math.min(150, width * 0.18);
    const plotW = width - axisW - profW;
    const top = 12, bottom = height - 22;
    const lo = Math.min(...candles.map((c) => c.l));
    const hi = Math.max(...candles.map((c) => c.h));
    const pad = (hi - lo) * 0.04 || 1;
    const pMin = lo - pad, pMax = hi + pad;
    const y = (p: number) => bottom - ((p - pMin) / (pMax - pMin)) * (bottom - top);
    const n = candles.length;
    const cw = plotW / n;
    const x = (i: number) => i * cw + cw / 2;

    // Grid + price axis.
    ctx.font = "11px 'JetBrains Mono Variable', monospace";
    ctx.textBaseline = "middle";
    for (let i = 0; i <= 6; i++) {
      const p = pMin + ((pMax - pMin) * i) / 6;
      ctx.strokeStyle = COL.grid;
      ctx.beginPath();
      ctx.moveTo(0, y(p));
      ctx.lineTo(plotW + profW, y(p));
      ctx.stroke();
      ctx.fillStyle = COL.text;
      ctx.fillText(fmt(p), plotW + profW + 8, y(p));
    }

    // Value area band.
    if (profile && showValueArea) {
      ctx.fillStyle = "rgba(255,179,107,0.05)";
      ctx.fillRect(0, y(profile.vah), plotW, y(profile.val) - y(profile.vah));
    }

    // Supply / demand zones extend to the right edge.
    if (showZones) {
      for (const z of zones) {
        const x0 = x(z.from) - cw / 2;
        const yt = y(z.high), yb = y(z.low);
        ctx.fillStyle = z.kind === "demand" ? COL.demand : COL.supply;
        ctx.fillRect(x0, yt, plotW - x0, Math.max(2, yb - yt));
        ctx.strokeStyle = z.kind === "demand" ? COL.demandEdge : COL.supplyEdge;
        ctx.setLineDash(z.tests ? [4, 4] : []);
        ctx.strokeRect(x0 + 0.5, yt + 0.5, plotW - x0 - 1, Math.max(2, yb - yt) - 1);
        ctx.setLineDash([]);
        ctx.fillStyle = z.kind === "demand" ? COL.demandEdge : COL.supplyEdge;
        ctx.font = "10px 'JetBrains Mono Variable', monospace";
        ctx.fillText(`${z.kind === "demand" ? "DEMAND" : "SUPPLY"} ${z.strength.toFixed(1)}×${z.tests ? ` · tested ${z.tests}` : " · fresh"}`, x0 + 4, z.kind === "demand" ? yb - 7 : yt + 8);
      }
    }

    // Candles.
    const bodyW = Math.max(1, cw * 0.65);
    for (let i = 0; i < n; i++) {
      const c = candles[i];
      const col = c.c >= c.o ? COL.up : COL.down;
      ctx.strokeStyle = col;
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.moveTo(x(i), y(c.h));
      ctx.lineTo(x(i), y(c.l));
      ctx.stroke();
      const yt = y(Math.max(c.o, c.c));
      ctx.fillRect(x(i) - bodyW / 2, yt, bodyW, Math.max(1, y(Math.min(c.o, c.c)) - yt));
    }

    // Volume profile histogram (right).
    if (profile) {
      const maxVol = Math.max(...profile.bins.map((b) => b.vol));
      for (const b of profile.bins) {
        const w = (b.vol / maxVol) * (profW - 8);
        const inVa = b.mid <= profile.vah && b.mid >= profile.val;
        ctx.fillStyle = Math.abs(b.mid - profile.poc) < 1e-9 ? COL.poc : inVa ? COL.profileVa : COL.profile;
        ctx.fillRect(plotW + profW - w, y(b.high) + 0.5, w, Math.max(1, y(b.low) - y(b.high) - 1));
      }
    }

    // POC + VAH / VAL lines.
    const hline = (p: number, color: string, label: string, dash: number[], widthPx: number) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = widthPx;
      ctx.setLineDash(dash);
      ctx.beginPath();
      ctx.moveTo(0, y(p));
      ctx.lineTo(plotW + profW, y(p));
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.lineWidth = 1;
      ctx.fillStyle = color;
      ctx.fillRect(plotW + profW + 2, y(p) - 9, axisW - 4, 18);
      ctx.fillStyle = "#0b0d11";
      ctx.fillText(`${label} ${fmt(p)}`.slice(0, 11), plotW + profW + 5, y(p));
    };
    if (profile && showValueArea) {
      hline(profile.vah, COL.va, "VAH", [5, 5], 1);
      hline(profile.val, COL.va, "VAL", [5, 5], 1);
    }
    if (profile && showPoc) {
      ctx.shadowColor = COL.poc;
      ctx.shadowBlur = 8;
      hline(profile.poc, COL.poc, "POC", [], 2);
      ctx.shadowBlur = 0;
    }

    // Last price.
    const last = candles[n - 1];
    ctx.fillStyle = last.c >= last.o ? COL.up : COL.down;
    ctx.fillRect(plotW + profW + 2, y(last.c) - 9, axisW - 4, 18);
    ctx.fillStyle = "#0b0d11";
    ctx.fillText(fmt(last.c), plotW + profW + 5, y(last.c));

    // Time labels.
    ctx.fillStyle = COL.text;
    ctx.font = "10px 'JetBrains Mono Variable', monospace";
    for (let i = 0; i < n; i += Math.max(1, Math.floor(n / 6))) {
      ctx.fillText(new Date(candles[i].t * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }), x(i) - 30, height - 9);
    }

    // Crosshair.
    if (hover && hover.x < plotW + profW) {
      const p = pMin + ((bottom - hover.y) / (bottom - top)) * (pMax - pMin);
      ctx.strokeStyle = "rgba(255,255,255,0.25)";
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(hover.x, top);
      ctx.lineTo(hover.x, bottom);
      ctx.moveTo(0, hover.y);
      ctx.lineTo(plotW + profW, hover.y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "#1e2330";
      ctx.fillRect(plotW + profW + 2, hover.y - 9, axisW - 4, 18);
      ctx.fillStyle = "#F8FAFC";
      ctx.fillText(fmt(p), plotW + profW + 5, hover.y);
      const i = Math.min(n - 1, Math.max(0, Math.floor(hover.x / cw)));
      const c = candles[i];
      if (hover.x < plotW) {
        ctx.fillStyle = "rgba(14,17,23,0.9)";
        ctx.fillRect(8, 8, 300, 20);
        ctx.fillStyle = COL.text;
        ctx.fillText(`O ${fmt(c.o)}  H ${fmt(c.h)}  L ${fmt(c.l)}  C ${fmt(c.c)}  V ${compact(c.v)}`, 14, 18);
      }
    }
  }, [candles, profile, zones, showPoc, showZones, showValueArea, width, height, hover]);

  return (
    <canvas
      ref={ref}
      className="block w-full cursor-crosshair"
      style={{ height }}
      onMouseMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        setHover({ x: e.clientX - r.left, y: e.clientY - r.top });
      }}
      onMouseLeave={() => setHover(null)}
      role="img"
      aria-label="Companion chart: candles, volume profile, supply and demand zones, point of control"
    />
  );
}

const fmt = (p: number) => (p >= 1000 ? p.toFixed(1) : p >= 10 ? p.toFixed(2) : p.toFixed(4));
const compact = (v: number) => (v >= 1e9 ? `${(v / 1e9).toFixed(1)}B` : v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}K` : String(v));
