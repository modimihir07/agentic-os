/**
 * Client for the gateway's shared local store (command_center_api.py, /api/cc).
 *
 * Phone and desktop both read/write here, so a note dictated on the phone over
 * NetBird shows up on the desktop within one sync tick (and vice versa).
 * Writes are optimistic; reads poll with `?since=` so only changed rows move.
 */
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { gateway, GatewayError, authHeader } from "@/lib/gateway";
import { useSettings } from "@/stores/settings";

export type Collection =
  | "cues"
  | "ideas"
  | "playplace"
  | "notes"
  | "reminders"
  | "pipeline"
  | "projects"
  | "income"
  | "goals"
  | "invoices"
  | "checks"
  | "receipts"
  | "documents"
  | "widgets";

export interface Meta {
  id: string;
  _created: number;
  _updated: number;
  _deleted?: boolean;
}

export type Item<T> = T & Meta;

const json = (body: unknown): RequestInit => ({ body: JSON.stringify(body) });

export const cc = {
  health: () =>
    gateway<{
      ok: boolean;
      llm: { ok: boolean; models?: string[]; error?: string };
      counts: Record<string, number>;
      vault: { items: number; embedded: number };
      lastBackup: BackupInfo | null;
    }>("/api/cc/health", { timeoutMs: 6000 }),
  list: <T>(c: Collection, since = 0) => gateway<{ items: Item<T>[]; now: number }>(`/api/cc/c/${c}?since=${since}`),
  create: <T>(c: Collection, data: Partial<T> & { id?: string }) => gateway<Item<T>>(`/api/cc/c/${c}`, { method: "POST", ...json(data) }),
  update: <T>(c: Collection, id: string, patch: Partial<T>) => gateway<Item<T>>(`/api/cc/c/${c}/${id}`, { method: "PATCH", ...json(patch) }),
  remove: (c: Collection, id: string) => gateway<{ ok: boolean }>(`/api/cc/c/${c}/${id}`, { method: "DELETE" }),
  kvGet: <T>(key: string) => gateway<{ value: T | null }>(`/api/cc/kv/${key}`),
  kvSet: (key: string, value: unknown) => gateway(`/api/cc/kv/${key}`, { method: "PUT", ...json({ value }) }),
  config: () => gateway<CcConfig>("/api/cc/config"),
  setConfig: (patch: DeepPartial<CcConfig>) => gateway<CcConfig>("/api/cc/config", { method: "PUT", ...json(patch) }),
  ocr: (fileId: string, kind: "receipt" | "invoice" | "check") =>
    gateway<OcrResult>("/api/cc/ocr", { method: "POST", ...json({ fileId, kind }), timeoutMs: 180_000 }),
  organize: (id: string) => gateway<Item<unknown>>("/api/cc/brainstorm/organize", { method: "POST", ...json({ id }), timeoutMs: 180_000 }),
  llmJson: <T>(system: string, prompt: string) => gateway<T>("/api/cc/llm/json", { method: "POST", ...json({ system, prompt }), timeoutMs: 120_000 }),
  search: (q: string, collections: Collection[] = [], k = 8) =>
    gateway<VaultResults>(`/api/cc/vault/search?q=${encodeURIComponent(q)}&collections=${collections.join(",")}&k=${k}`),
  reindex: () => gateway<{ queued: number }>("/api/cc/vault/reindex", { method: "POST" }),
  backupNow: () => gateway<BackupInfo>("/api/cc/backup", { method: "POST", timeoutMs: 120_000 }),
  backups: () => gateway<{ dir: string; last: BackupInfo | null; backups: { name: string; size: number; at: number }[] }>("/api/cc/backups"),
  candles: (symbol: string, interval: string, range: string) =>
    gateway<MarketData>(`/api/cc/market/candles?symbol=${encodeURIComponent(symbol)}&interval=${interval}&range=${range}`, { timeoutMs: 20_000 }),
  fileUrl: (id: string) => `${useSettings.getState().gatewayUrl.replace(/\/+$/, "")}/api/cc/files/${id}`,
  /** Multipart upload (images from the camera, PDFs). */
  upload: async (blob: Blob, name: string): Promise<{ id: string; name: string; mime: string; size: number }> => {
    const fd = new FormData();
    fd.append("file", blob, name);
    const base = useSettings.getState().gatewayUrl.replace(/\/+$/, "");
    const res = await fetch(`${base}/api/cc/files`, { method: "POST", body: fd, headers: authHeader(useSettings.getState().gatewayToken) });
    if (!res.ok) throw new GatewayError((await res.json().catch(() => ({}))).detail ?? `Upload failed (${res.status})`, res.status);
    return res.json();
  },
};

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

export interface CcConfig {
  llm: { baseUrl: string; model: string; visionModel: string; embeddingModel: string; timeoutSecs: number };
  backup: { enabled: boolean; intervalHours: number; keep: number; dir: string };
}

export interface BackupInfo {
  file: string;
  size: number;
  at: number;
  reason: string;
}

export interface OcrFields {
  vendor?: string | null;
  date?: string | null;
  subtotal?: number | null;
  gst?: number | null;
  hst?: number | null;
  pst?: number | null;
  qst?: number | null;
  tip?: number | null;
  total?: number | null;
  currency?: string | null;
  invoiceNumber?: string | null;
  payer?: string | null;
  chequeNumber?: string | null;
  memo?: string | null;
  category?: string | null;
  items?: { desc: string; amount: number }[];
  confidence?: number;
}

export interface OcrResult {
  fields: OcrFields;
  check: { regime: string | null; flags: string[]; taxTotal: number };
  engine: string;
  raw: string;
}

export interface VaultResults {
  mode: "hybrid" | "lexical" | "empty";
  results: { score: number; collection: Collection; id: string; snippet: string; item: Item<Record<string, unknown>> | null }[];
}

export interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export interface MarketData {
  symbol: string;
  currency: string | null;
  exchange: string | null;
  price: number | null;
  candles: Candle[];
  fetchedAt: number;
  source: string;
}

// ── useCollection: synced, optimistic, shared across components ─────────────

interface CollState {
  items: Map<string, Item<unknown>>;
  since: number;
  error: string | null;
  loaded: boolean;
  subscribers: Set<() => void>;
  snapshot: Item<unknown>[];
  timer?: ReturnType<typeof setTimeout>;
}

const stores = new Map<Collection, CollState>();
const SYNC_MS = 6000;

function storeFor(c: Collection): CollState {
  let s = stores.get(c);
  if (!s) {
    s = { items: new Map(), since: 0, error: null, loaded: false, subscribers: new Set(), snapshot: [] };
    stores.set(c, s);
  }
  return s;
}

function emit(s: CollState) {
  s.snapshot = [...s.items.values()].filter((i) => !i._deleted).sort((a, b) => b._created - a._created);
  s.subscribers.forEach((f) => f());
}

async function sync(c: Collection) {
  const s = storeFor(c);
  try {
    const { items, now } = await cc.list<unknown>(c, s.since);
    for (const it of items) s.items.set(it.id, it);
    s.since = Math.max(s.since, now - 2); // small overlap for clock skew between writes
    s.error = null;
    s.loaded = true;
    if (items.length || !s.loaded) emit(s);
    else s.subscribers.forEach((f) => f());
  } catch (e) {
    s.error = e instanceof Error ? e.message : String(e);
    s.loaded = true;
    s.subscribers.forEach((f) => f());
  }
}

function startPolling(c: Collection) {
  const s = storeFor(c);
  if (s.timer) return;
  const loop = async () => {
    if (!document.hidden) await sync(c);
    s.timer = setTimeout(loop, SYNC_MS);
  };
  void loop();
  window.addEventListener("focus", () => void sync(c));
}

function stopPolling(c: Collection) {
  const s = storeFor(c);
  if (s.subscribers.size === 0 && s.timer) {
    clearTimeout(s.timer);
    s.timer = undefined;
  }
}

/** Live view of one shared collection, plus optimistic mutators. */
export function useCollection<T>(c: Collection) {
  const s = storeFor(c);
  const subscribe = useCallback(
    (f: () => void) => {
      s.subscribers.add(f);
      startPolling(c);
      return () => {
        s.subscribers.delete(f);
        stopPolling(c);
      };
    },
    [c, s],
  );
  const items = useSyncExternalStore(subscribe, () => s.snapshot) as Item<T>[];
  const status = useSyncExternalStore(subscribe, () => `${s.loaded}|${s.error ?? ""}`);
  const [loaded, error] = status.split("|");

  const create = useCallback(
    async (data: Partial<T>) => {
      const id = crypto.randomUUID();
      const now = Date.now() / 1000;
      s.items.set(id, { ...(data as object), id, _created: now, _updated: now } as Item<unknown>);
      emit(s);
      try {
        const saved = await cc.create<T>(c, { ...data, id });
        s.items.set(id, saved as Item<unknown>);
        emit(s);
        return saved;
      } catch (e) {
        s.items.delete(id);
        emit(s);
        throw e;
      }
    },
    [c, s],
  );

  const update = useCallback(
    async (id: string, patch: Partial<T>) => {
      const prev = s.items.get(id);
      if (prev) s.items.set(id, { ...prev, ...(patch as object) });
      emit(s);
      try {
        const saved = await cc.update<T>(c, id, patch);
        s.items.set(id, saved as Item<unknown>);
        emit(s);
        return saved;
      } catch (e) {
        if (prev) s.items.set(id, prev);
        emit(s);
        throw e;
      }
    },
    [c, s],
  );

  const remove = useCallback(
    async (id: string) => {
      const prev = s.items.get(id);
      s.items.delete(id);
      emit(s);
      try {
        await cc.remove(c, id);
      } catch (e) {
        if (prev) s.items.set(id, prev);
        emit(s);
        throw e;
      }
    },
    [c, s],
  );

  return { items, loaded: loaded === "true", error: error || null, create, update, remove, refresh: () => sync(c) };
}

/** Non-hook access (voice intents, schedulers). */
export const collections = {
  create: async <T>(c: Collection, data: Partial<T>) => {
    const saved = await cc.create<T>(c, data);
    const s = storeFor(c);
    s.items.set(saved.id, saved as Item<unknown>);
    emit(s);
    return saved;
  },
  update: async <T>(c: Collection, id: string, patch: Partial<T>) => {
    const saved = await cc.update<T>(c, id, patch);
    const s = storeFor(c);
    s.items.set(id, saved as Item<unknown>);
    emit(s);
    return saved;
  },
  snapshot: <T>(c: Collection) => storeFor(c).snapshot as Item<T>[],
  sync: (c: Collection) => sync(c),
};

/** Re-render on an interval (countdowns). */
export function useNow(ms = 1000) {
  const ref = useRef(Date.now());
  const subscribe = useCallback(
    (f: () => void) => {
      const t = setInterval(() => {
        ref.current = Date.now();
        f();
      }, ms);
      return () => clearInterval(t);
    },
    [ms],
  );
  return useSyncExternalStore(subscribe, () => ref.current);
}

export function useEffectOnce(fn: () => void | (() => void)) {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(fn, []);
}
