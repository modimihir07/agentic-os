import { TvChart } from "@/features/trading/TvChart";
import { cmd, isTauri } from "@/lib/platform";
import { useEffect, useMemo, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { Card, Chip, Input, Select, Stat } from "@/components/ui";
import { cc, type MarketData } from "@/lib/cc-api";
import { useSettings } from "@/stores/settings";
import { supplyDemandZones, toTradingView, volumeProfile } from "@/features/trading/analysis";
import { CompanionChart } from "@/features/trading/CompanionChart";

const INTERVALS: [string, string, string][] = [
  // [yahoo, label, tradingview]
  ["1m", "1m", "1"],
  ["5m", "5m", "5"],
  ["15m", "15m", "15"],
  ["30m", "30m", "30"],
  ["60m", "1h", "60"],
  ["1d", "1D", "D"],
];
const RANGES = ["1d", "5d", "1mo", "3mo", "6mo", "1y"];

/**
 * Day Trading — research only. No broker connection, no order entry.
 * TradingView widgets + news on top; below, a companion chart fed by live
 * candles from the local gateway with Supply/Demand zones and the POC.
 */
export function TradingSection() {
  const t = useSettings((s) => s.trading);
  const set = useSettings((s) => s.set);
  const up = (patch: Partial<typeof t>) => set({ trading: { ...t, ...patch } });
  const [symbolInput, setSymbolInput] = useState(t.symbol);
  const [data, setData] = useState<MarketData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [bins, setBins] = useState(48);

  const load = async () => {
    setLoading(true);
    try {
      // Desktop fetches directly (works with the gateway down); the phone uses the gateway.
      setData(isTauri() ? await cmd("market_candles", { symbol: t.symbol, interval: t.interval, range: t.range }).catch(() => cc.candles(t.symbol, t.interval, t.range)) : await cc.candles(t.symbol, t.interval, t.range));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  // "Live": refresh on a cadence matched to the bar size; paused while hidden.
  useEffect(() => {
    void load();
    const ms = t.interval === "1d" ? 300_000 : t.interval === "1m" ? 15_000 : 30_000;
    const id = setInterval(() => !document.hidden && void load(), ms);
    return () => clearInterval(id);
  }, [t.symbol, t.interval, t.range]); // eslint-disable-line react-hooks/exhaustive-deps

  const candles = data?.candles ?? [];
  const profile = useMemo(() => volumeProfile(candles, bins), [candles, bins]);
  const zones = useMemo(() => supplyDemandZones(candles), [candles]);
  const last = candles.at(-1);
  const tvInterval = INTERVALS.find((i) => i[0] === t.interval)?.[2] ?? "5";

  const newsSrc = `https://www.tradingview-widget.com/embed-widget/timeline/?locale=en#${encodeURIComponent(
    JSON.stringify({ feedMode: "symbol", symbol: t.tvSymbol, colorTheme: "dark", isTransparent: true, displayMode: "regular", width: "100%", height: "100%" }),
  )}`;

  return (
    <div className="mx-auto h-full w-full max-w-7xl space-y-4 overflow-y-auto px-4 pb-32 md:px-6 md:pb-8">
      <div className="glass flex flex-wrap items-center gap-2 rounded-[18px] p-2.5">
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const s = symbolInput.trim().toUpperCase();
            if (s) up({ symbol: s, tvSymbol: toTradingView(s) });
          }}
        >
          <Input value={symbolInput} onChange={(e) => setSymbolInput(e.target.value)} className="!h-9 !w-36 !py-1 font-mono text-[13px] uppercase" aria-label="Ticker" placeholder="SPY, ES=F, BTC-USD" />
          <button className="pill-primary !h-9 text-xs">Load</button>
        </form>
        <Input
          value={t.tvSymbol}
          onChange={(e) => up({ tvSymbol: e.target.value.toUpperCase() })}
          className="!h-9 !w-40 !py-1 font-mono text-[12px]"
          aria-label="TradingView symbol"
          title="TradingView symbol (auto-mapped; override if needed)"
        />
        <div className="flex gap-1">
          {INTERVALS.map(([v, label]) => (
            <Chip key={v} active={t.interval === v} onClick={() => up({ interval: v, range: v === "1m" ? "1d" : v === "1d" ? "6mo" : t.range === "1d" && v !== "1m" ? "5d" : t.range })}>
              {label}
            </Chip>
          ))}
        </div>
        <Select value={t.range} onChange={(e) => up({ range: e.target.value })} className="!h-9 !w-auto !py-1 text-[13px]" aria-label="Range">
          {RANGES.map((r) => (
            <option key={r}>{r}</option>
          ))}
        </Select>
        <span className="ml-auto text-[11px] text-ink-3">Research only — no broker connection.</span>
      </div>

      <div className="grid gap-4 xl:grid-cols-[1.7fr_1fr]">
        <Card title={`TradingView · ${t.tvSymbol}`} className="!p-3">
          <TvChart symbol={t.tvSymbol} interval={tvInterval} />
        </Card>
        <Card title="Market news" className="!p-3">
          <iframe key={newsSrc} src={newsSrc} title="Market news" className="h-[440px] w-full rounded-[12px] border-0" loading="lazy" />
        </Card>
      </div>

      <Card
        title={`Supply / demand & POC · ${data?.symbol ?? t.symbol} · ${t.interval}`}
        hint={data ? `${candles.length} bars · ${data.source} · updated ${new Date(data.fetchedAt * 1000).toLocaleTimeString()}` : undefined}
        action={
          <div className="flex flex-wrap items-center gap-1.5">
            <Chip active={t.showPoc} onClick={() => up({ showPoc: !t.showPoc })}>
              POC
            </Chip>
            <Chip active={t.showValueArea} onClick={() => up({ showValueArea: !t.showValueArea })}>
              Value area
            </Chip>
            <Chip active={t.showZones} onClick={() => up({ showZones: !t.showZones })} tone="teal">
              Zones
            </Chip>
            <Select value={bins} onChange={(e) => setBins(Number(e.target.value))} className="!h-8 !w-auto !py-0 text-[12px]" aria-label="Profile resolution">
              {[24, 48, 72, 96].map((b) => (
                <option key={b} value={b}>
                  {b} bins
                </option>
              ))}
            </Select>
            <button onClick={() => void load()} aria-label="Refresh" className="pill-glass !h-8 !w-8 !p-0">
              {loading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
            </button>
          </div>
        }
      >
        {error && <p className="mb-2 text-sm text-alert">{error}</p>}
        {candles.length ? (
          <CompanionChart candles={candles} profile={profile} zones={zones} showPoc={t.showPoc} showZones={t.showZones} showValueArea={t.showValueArea} />
        ) : (
          <div className="grid h-[300px] place-items-center text-sm text-ink-3">{loading ? "Loading candles…" : "No data — check the ticker (Yahoo format: SPY, ES=F, BTC-USD, SHOP.TO)."}</div>
        )}
        {profile && last && (
          <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-5">
            <Stat label="Last" value={last.c.toFixed(2)} tone={last.c >= last.o ? "teal" : "alert"} />
            <Stat label="POC" value={profile.poc.toFixed(2)} sub={`${(((last.c - profile.poc) / profile.poc) * 100).toFixed(2)}% from price`} tone="amber" />
            <Stat label="Value area" value={`${profile.val.toFixed(2)} – ${profile.vah.toFixed(2)}`} sub={last.c > profile.vah ? "price above VA" : last.c < profile.val ? "price below VA" : "price inside VA"} />
            <Stat label="Demand zones" value={zones.filter((z) => z.kind === "demand").length} sub={nearest(zones, "demand", last.c)} tone="teal" />
            <Stat label="Supply zones" value={zones.filter((z) => z.kind === "supply").length} sub={nearest(zones, "supply", last.c)} tone="alert" />
          </div>
        )}
        <p className="mt-3 text-[11px] text-ink-3">
          Zones: a tight base followed by a ≥1.5×ATR move; dashed = already tested, removed once price closes through. Volume is spread across each bar's range. Educational tool, not trading advice.
        </p>
      </Card>
    </div>
  );
}

function nearest(zones: { kind: string; low: number; high: number }[], kind: string, price: number) {
  const zs = zones.filter((z) => z.kind === kind);
  if (!zs.length) return "none active";
  const z = zs.reduce((a, b) => (Math.abs((b.low + b.high) / 2 - price) < Math.abs((a.low + a.high) / 2 - price) ? b : a));
  return `nearest ${z.low.toFixed(2)}–${z.high.toFixed(2)}`;
}
