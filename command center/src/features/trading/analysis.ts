import type { Candle } from "@/lib/cc-api";

/**
 * Market-structure math for the companion chart. Pure functions, no I/O.
 *
 * Volume profile: each candle's volume is spread evenly across the price
 * range it traded (low → high), into fixed-size price bins.
 *   POC  = the bin with the most volume (price where the most traded).
 *   Value area = the contiguous band around the POC holding 70 % of volume
 *                (VAH / VAL are its edges).
 *
 * Supply / demand zones (base → impulse):
 *   a "base" is 1–3 small-bodied, tight candles (range ≤ 1.2 × ATR, body ≤ 50 %
 *   of range); if price then leaves it with a displacement ≥ 1.5 × ATR within 3
 *   candles, the base becomes a demand zone (rally) or supply zone (drop).
 *   A later close through the far side of the zone = broken (dropped);
 *   a wick back into it = tested (kept, marked).
 */

export interface ProfileBin {
  low: number;
  high: number;
  mid: number;
  vol: number;
}

export interface Profile {
  bins: ProfileBin[];
  poc: number;
  vah: number;
  val: number;
  total: number;
}

export interface Zone {
  kind: "demand" | "supply";
  low: number;
  high: number;
  /** Index of the first base candle (the zone extends right from here). */
  from: number;
  strength: number; // displacement in ATRs
  tests: number;
}

export function atr(c: Candle[], period = 14): number[] {
  const out: number[] = [];
  let prev = 0;
  for (let i = 0; i < c.length; i++) {
    const tr = i === 0 ? c[i].h - c[i].l : Math.max(c[i].h - c[i].l, Math.abs(c[i].h - c[i - 1].c), Math.abs(c[i].l - c[i - 1].c));
    prev = i < period ? (prev * i + tr) / (i + 1) : (prev * (period - 1) + tr) / period;
    out.push(prev);
  }
  return out;
}

export function volumeProfile(c: Candle[], binCount = 48, valueArea = 0.7): Profile | null {
  if (!c.length) return null;
  const lo = Math.min(...c.map((x) => x.l));
  const hi = Math.max(...c.map((x) => x.h));
  if (!(hi > lo)) return null;
  const step = (hi - lo) / binCount;
  const bins: ProfileBin[] = Array.from({ length: binCount }, (_, i) => ({ low: lo + i * step, high: lo + (i + 1) * step, mid: lo + (i + 0.5) * step, vol: 0 }));

  for (const k of c) {
    if (!k.v) continue;
    const range = k.h - k.l;
    if (range <= 0) {
      bins[Math.min(binCount - 1, Math.floor((k.c - lo) / step))].vol += k.v;
      continue;
    }
    const a = Math.max(0, Math.floor((k.l - lo) / step));
    const b = Math.min(binCount - 1, Math.floor((k.h - lo) / step));
    for (let i = a; i <= b; i++) {
      const overlap = Math.min(bins[i].high, k.h) - Math.max(bins[i].low, k.l);
      if (overlap > 0) bins[i].vol += (k.v * overlap) / range;
    }
  }

  const total = bins.reduce((s, b) => s + b.vol, 0);
  if (!total) return null;
  let pocIdx = 0;
  bins.forEach((b, i) => b.vol > bins[pocIdx].vol && (pocIdx = i));

  // Expand outward from the POC, always taking the heavier neighbour.
  let up = pocIdx, down = pocIdx, acc = bins[pocIdx].vol;
  while (acc < total * valueArea && (up < binCount - 1 || down > 0)) {
    const nextUp = up < binCount - 1 ? bins[up + 1].vol : -1;
    const nextDown = down > 0 ? bins[down - 1].vol : -1;
    if (nextUp >= nextDown) acc += bins[++up].vol;
    else acc += bins[--down].vol;
  }
  return { bins, poc: bins[pocIdx].mid, vah: bins[up].high, val: bins[down].low, total };
}

export function supplyDemandZones(c: Candle[], opts: { maxPerSide?: number; impulseAtr?: number } = {}): Zone[] {
  const maxPerSide = opts.maxPerSide ?? 4;
  const impulse = opts.impulseAtr ?? 1.5;
  if (c.length < 20) return [];
  const a = atr(c);
  const isBase = (i: number) => {
    const r = c[i].h - c[i].l;
    return r > 0 && r <= 1.2 * a[i] && Math.abs(c[i].c - c[i].o) <= 0.5 * r;
  };

  const zones: Zone[] = [];
  for (let i = 14; i < c.length - 2; i++) {
    if (!isBase(i) || isBase(i + 1)) continue; // i = last candle of a base cluster
    let start = i;
    while (start > i - 2 && start > 14 && isBase(start - 1)) start--;
    const low = Math.min(...c.slice(start, i + 1).map((x) => x.l));
    const high = Math.max(...c.slice(start, i + 1).map((x) => x.h));
    const look = c.slice(i + 1, Math.min(c.length, i + 4));
    const upMove = Math.max(...look.map((x) => x.h)) - high;
    const downMove = low - Math.min(...look.map((x) => x.l));
    const ref = a[i] || 1e-9;
    if (upMove >= impulse * ref && look.some((x) => x.c > high)) zones.push({ kind: "demand", low, high, from: start, strength: upMove / ref, tests: 0 });
    else if (downMove >= impulse * ref && look.some((x) => x.c < low)) zones.push({ kind: "supply", low, high, from: start, strength: downMove / ref, tests: 0 });
  }

  // Lifecycle: tested (wick back in) vs broken (close through the far side).
  const alive = zones.filter((z) => {
    let away = false;
    for (let j = z.from + 3; j < c.length; j++) {
      const k = c[j];
      if (z.kind === "demand") {
        if (k.c < z.low) return false;
        if (k.l > z.high) away = true;
        else if (away && k.l <= z.high) {
          z.tests++;
          away = false;
        }
      } else {
        if (k.c > z.high) return false;
        if (k.h < z.low) away = true;
        else if (away && k.h >= z.low) {
          z.tests++;
          away = false;
        }
      }
    }
    return true;
  });

  const pick = (kind: Zone["kind"]) => alive.filter((z) => z.kind === kind).slice(-maxPerSide);
  return [...pick("demand"), ...pick("supply")];
}

/** Best-effort Yahoo → TradingView symbol mapping (you can always override it). */
export function toTradingView(symbol: string): string {
  const s = symbol.toUpperCase();
  if (/^[A-Z]+-USD$/.test(s)) return `COINBASE:${s.replace("-", "")}`;
  const fut: Record<string, string> = { "ES=F": "CME_MINI:ES1!", "NQ=F": "CME_MINI:NQ1!", "YM=F": "CBOT_MINI:YM1!", "RTY=F": "CME_MINI:RTY1!", "CL=F": "NYMEX:CL1!", "GC=F": "COMEX:GC1!", "SI=F": "COMEX:SI1!" };
  if (fut[s]) return fut[s];
  const idx: Record<string, string> = { "^GSPC": "SP:SPX", "^IXIC": "NASDAQ:IXIC", "^DJI": "DJ:DJI", "^VIX": "CBOE:VIX", "^GSPTSE": "TSX:TSX" };
  if (idx[s]) return idx[s];
  if (s.endsWith(".TO")) return `TSX:${s.slice(0, -3)}`;
  if (s.endsWith("=X")) return `FX:${s.slice(0, -2)}`;
  return s;
}
