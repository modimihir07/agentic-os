import { useEffect, useId, useRef, useState } from "react";

/**
 * TradingView's official free embed (https://s3.tradingview.com/tv.js), dark
 * and transparent so the wallpaper shows at the edges. The script is loaded
 * once and reused; each symbol / interval change rebuilds the widget.
 *
 * Why not the bare widgetembed iframe: with `referrerPolicy="no-referrer"`
 * TradingView can't identify the embedding page and serves a blank white
 * frame. tv.js builds the iframe itself with the right parameters.
 */
declare global {
  interface Window {
    TradingView?: { widget: new (opts: Record<string, unknown>) => unknown };
  }
}

let loader: Promise<void> | null = null;
function loadTv(): Promise<void> {
  if (window.TradingView) return Promise.resolve();
  loader ??= new Promise<void>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://s3.tradingview.com/tv.js";
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => {
      loader = null;
      reject(new Error("tv.js blocked or offline"));
    };
    document.head.appendChild(s);
  });
  return loader;
}

export function TvChart({ symbol, interval, height = 440 }: { symbol: string; interval: string; height?: number }) {
  const id = `tv_${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const host = useRef<HTMLDivElement>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setErr(null);
    loadTv()
      .then(() => {
        if (cancelled || !host.current || !window.TradingView) return;
        host.current.innerHTML = "";
        new window.TradingView.widget({
          container_id: id,
          autosize: true,
          symbol,
          interval,
          timezone: "America/Toronto",
          theme: "dark",
          style: "1",
          locale: "en",
          toolbar_bg: "rgba(0,0,0,0)",
          backgroundColor: "rgba(11,13,17,0.15)",
          gridColor: "rgba(255,255,255,0.06)",
          enable_publishing: false,
          allow_symbol_change: true,
          hide_side_toolbar: false,
          withdateranges: true,
          save_image: false,
        });
      })
      .catch((e: Error) => !cancelled && setErr(e.message));
    return () => {
      cancelled = true;
    };
  }, [id, symbol, interval]);

  return (
    <div style={{ height }} className="relative w-full overflow-hidden rounded-[12px]">
      <div id={id} ref={host} className="h-full w-full" />
      {err && <p className="absolute inset-0 grid place-items-center text-sm text-ink-3">TradingView unavailable — {err}</p>}
    </div>
  );
}
