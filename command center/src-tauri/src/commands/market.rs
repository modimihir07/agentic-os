//! Read-only market candles fetched by the desktop itself, so the Supply /
//! Demand chart works even when the gateway is down. Yahoo Finance first (no
//! key); Twelve Data as an optional fallback when a key is saved in Settings.
//! No broker connections, no orders — data only.

use serde::Serialize;
use serde_json::Value;
use std::time::Duration;
use tauri::State;

use super::dispatch::{short, DispatchState};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Candle {
    t: i64,
    o: f64,
    h: f64,
    l: f64,
    c: f64,
    v: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketData {
    symbol: String,
    currency: Option<String>,
    exchange: Option<String>,
    price: Option<f64>,
    candles: Vec<Candle>,
    fetched_at: f64,
    source: String,
}

const INTERVALS: [&str; 7] = ["1m", "2m", "5m", "15m", "30m", "60m", "1d"];
const RANGES: [&str; 6] = ["1d", "5d", "1mo", "3mo", "6mo", "1y"];

fn valid_symbol(s: &str) -> bool {
    !s.is_empty() && s.len() <= 24 && s.chars().all(|c| c.is_ascii_alphanumeric() || ".^=-/".contains(c))
}

fn now() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs_f64()
}

async fn yahoo(state: &DispatchState, symbol: &str, interval: &str, range: &str) -> Result<MarketData, String> {
    let url = format!("https://query1.finance.yahoo.com/v8/finance/chart/{}", urlencode(symbol));
    let v: Value = state
        .http
        .get(url)
        .query(&[("interval", interval), ("range", range), ("includePrePost", "false")])
        .header("User-Agent", "Mozilla/5.0 (CommandCenter)")
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(short)?
        .error_for_status()
        .map_err(short)?
        .json()
        .await
        .map_err(short)?;
    let res = &v["chart"]["result"][0];
    if res.is_null() {
        return Err("unknown symbol".into());
    }
    let q = &res["indicators"]["quote"][0];
    let mut candles = Vec::new();
    for (i, t) in res["timestamp"].as_array().into_iter().flatten().enumerate() {
        let f = |k: &str| q[k][i].as_f64();
        if let (Some(t), Some(o), Some(h), Some(l), Some(c)) = (t.as_i64(), f("open"), f("high"), f("low"), f("close")) {
            candles.push(Candle { t, o, h, l, c, v: f("volume").unwrap_or(0.0) });
        }
    }
    let m = &res["meta"];
    Ok(MarketData {
        symbol: m["symbol"].as_str().unwrap_or(symbol).into(),
        currency: m["currency"].as_str().map(String::from),
        exchange: m["exchangeName"].as_str().map(String::from),
        price: m["regularMarketPrice"].as_f64(),
        candles,
        fetched_at: now(),
        source: "Yahoo Finance via desktop (unofficial, may be delayed)".into(),
    })
}

fn urlencode(s: &str) -> String {
    s.chars().map(|c| if c.is_ascii_alphanumeric() || "-._".contains(c) { c.to_string() } else { format!("%{:02X}", c as u32) }).collect()
}

async fn twelvedata(state: &DispatchState, key: &str, symbol: &str, interval: &str) -> Result<MarketData, String> {
    let iv = match interval {
        "1m" => "1min",
        "2m" | "5m" => "5min",
        "15m" => "15min",
        "30m" => "30min",
        "60m" => "1h",
        _ => "1day",
    };
    // Twelve Data uses "BTC/USD" and plain tickers; strip Yahoo suffixes it can't read.
    let sym = symbol.replace("-USD", "/USD").replace("=F", "");
    let v: Value = state
        .http
        .get("https://api.twelvedata.com/time_series")
        .query(&[("symbol", sym.as_str()), ("interval", iv), ("outputsize", "500"), ("apikey", key), ("order", "ASC")])
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(short)?
        .json()
        .await
        .map_err(short)?;
    if v["status"] == "error" {
        return Err(v["message"].as_str().unwrap_or("Twelve Data error").chars().take(160).collect());
    }
    let mut candles = Vec::new();
    for r in v["values"].as_array().into_iter().flatten() {
        let n = |k: &str| r[k].as_str().and_then(|s| s.parse::<f64>().ok());
        let t = r["datetime"].as_str().and_then(|d| {
            chrono::NaiveDateTime::parse_from_str(d, "%Y-%m-%d %H:%M:%S").ok().or_else(|| chrono::NaiveDate::parse_from_str(d, "%Y-%m-%d").ok().and_then(|x| x.and_hms_opt(0, 0, 0)))
        });
        if let (Some(t), Some(o), Some(h), Some(l), Some(c)) = (t, n("open"), n("high"), n("low"), n("close")) {
            candles.push(Candle { t: t.and_utc().timestamp(), o, h, l, c, v: n("volume").unwrap_or(0.0) });
        }
    }
    let price = candles.last().map(|c| c.c);
    Ok(MarketData {
        symbol: symbol.into(),
        currency: v["meta"]["currency"].as_str().map(String::from),
        exchange: v["meta"]["exchange"].as_str().map(String::from),
        price,
        candles,
        fetched_at: now(),
        source: "Twelve Data".into(),
    })
}

#[tauri::command]
pub async fn market_candles(state: State<'_, DispatchState>, symbol: String, interval: String, range: String) -> Result<MarketData, String> {
    if !valid_symbol(&symbol) || !INTERVALS.contains(&interval.as_str()) || !RANGES.contains(&range.as_str()) {
        return Err("bad symbol / interval / range".into());
    }
    match yahoo(&state, &symbol, &interval, &range).await {
        Ok(d) if !d.candles.is_empty() => Ok(d),
        first => {
            let why = first.err().unwrap_or_else(|| "no candles".into());
            // env / repo .env / keychain; the Twelve Data host is hard-coded in `twelvedata`.
            match super::envfile::os_key(&state, "twelvedata") {
                Some(k) => twelvedata(&state, &k, &symbol, &interval).await.map_err(|e| format!("Yahoo: {why}; Twelve Data: {e}")),
                None => Err(format!("Yahoo: {why} (add a Twelve Data key in Settings → Integrations, or set TWELVEDATA_API_KEY in the repo-root .env, for a fallback)")),
            }
        }
    }
}
