import { useEffect } from "react";
import { create } from "zustand";
import { cmd, isTauri, type OsKeySources, type OsKeyStatus, type OsSecret } from "@/lib/platform";
import { useOnIntegrationsChanged } from "./changed";

/**
 * Where each OS secret is resolved from (process env → repo-root .env → keychain), shared
 * by every Settings key row so two rows for the same key always agree. One
 * `os_secret_sources` call (presence and source names only — never a value) per refresh;
 * refreshed on `integrations-changed` (in-app saves / deletes / imports) and on window
 * focus (hand edits to .env).
 */

/** Longest value the OS keychain accepts from Settings (Rust `secrets::MAX_SECRET_CHARS`). */
export const MAX_SECRET_CHARS = 1024;

/** Client-side check before `os_secret_set` (Rust repeats it). Null = OK. */
export function secretInputError(value: string): string | null {
  const v = value.trim();
  if (!v) return "Paste a value first.";
  if ([...v].length > MAX_SECRET_CHARS) return `Too long for the OS keychain (max ${MAX_SECRET_CHARS} characters) — check you pasted only the key.`;
  return null;
}

export type BadgeTone = "ok" | "warn" | "muted";
export interface KeyBadge {
  label: string;
  tone: BadgeTone;
  /** Where the key comes from / how to set it. Names only. */
  detail: string | null;
  placeholder: string;
  /** A keychain entry exists, so the delete button means something. */
  canDelete: boolean;
}

/** The badge a key row shows. `st` undefined = not loaded yet (or unavailable). */
export function keyBadge(st: OsKeyStatus | undefined, meta: Pick<OsKeySources, "envFile" | "envFileFound"> | null, placeholder?: string): KeyBadge {
  if (!st) return { label: "…", tone: "muted", detail: null, placeholder: placeholder ?? "Paste key…", canDelete: false };
  const fallback = st.keychain ? " · keychain fallback saved" : "";
  switch (st.source) {
    case "env":
      return { label: "LOADED FROM ENVIRONMENT", tone: "warn", detail: `${st.envVar} (process env)${fallback}`, placeholder: "Optional keychain fallback…", canDelete: st.keychain };
    case "env-file":
      return { label: "LOADED FROM .ENV", tone: "ok", detail: `${st.envVar} in .env${fallback}`, placeholder: "Optional keychain fallback…", canDelete: st.keychain };
    case "keychain":
      return { label: "SAVED IN KEYCHAIN", tone: "ok", detail: st.envVar ? `set ${st.envVar} in the repo-root .env to override` : null, placeholder: "Replace…", canDelete: true };
    default: {
      const parts: string[] = [];
      if (st.pairIncomplete) parts.push("Gmail needs both ID and key from the same place (both in .env, or both in the keychain)");
      else if (st.envVar) parts.push(`paste it here, or set ${st.envVar} in the repo-root .env`);
      if (st.envVar && meta && !meta.envFileFound) parts.push(`.env not found at ${meta.envFile}`);
      return { label: "NOT SET", tone: "muted", detail: parts.join(" · ") || null, placeholder: placeholder ?? "Paste key…", canDelete: st.keychain };
    }
  }
}

const GMAIL: OsSecret[] = ["gmail-script-id", "gmail-script-key"];

/**
 * Optimistic local update after a keychain save (`present`) or delete for `name`, so every
 * row flips at once; the reload that follows is the source of truth. Gmail is pair-level:
 * only its keychain flag changes here and the reload settles the source.
 */
export function withKeychain(src: OsKeySources, name: OsSecret, present: boolean): OsKeySources {
  const cur = src.keys[name];
  if (!cur) return src;
  let next: OsKeyStatus = { ...cur, keychain: present };
  if (!GMAIL.includes(name)) {
    const fromEnv = cur.source === "env" || cur.source === "env-file";
    if (!fromEnv) next = { ...next, source: present ? "keychain" : "missing" };
  }
  return { ...src, keys: { ...src.keys, [name]: next } };
}

interface KeySourcesStore {
  data: OsKeySources | null;
  error: string | null;
  load: () => Promise<void>;
  /** Optimistic keychain change (see `withKeychain`), then a reload. */
  markKeychain: (name: OsSecret, present: boolean) => void;
}

let inflight: Promise<void> | null = null;
let again = false;

export const useKeySourcesStore = create<KeySourcesStore>((set, get) => ({
  data: null,
  error: null,
  load: () => {
    if (!isTauri()) {
      set({ error: "Key status needs the desktop app" });
      return Promise.resolve();
    }
    // A refresh asked for mid-flight runs once more afterwards (the in-flight one may predate the change).
    if (inflight) {
      again = true;
      return inflight;
    }
    inflight = cmd("os_secret_sources")
      .then((data) => set({ data, error: null }))
      .catch((e) => set({ error: String(e) }))
      .finally(() => {
        inflight = null;
        if (again) {
          again = false;
          void get().load();
        }
      });
    return inflight;
  },
  markKeychain: (name, present) => {
    const d = get().data;
    if (d) set({ data: withKeychain(d, name, present) });
    void get().load();
  },
}));

let focusHooked = false;
let lastFocus = 0;
function hookFocus() {
  if (focusHooked || typeof window === "undefined") return;
  focusHooked = true;
  window.addEventListener("focus", () => {
    const now = Date.now();
    if (now - lastFocus < 1500) return;
    lastFocus = now;
    void useKeySourcesStore.getState().load();
  });
}

/** Shared key-source status; loads on first use, refreshes on integrations-changed and focus. */
export function useKeySources(): Pick<KeySourcesStore, "data" | "error" | "markKeychain"> {
  const data = useKeySourcesStore((s) => s.data);
  const error = useKeySourcesStore((s) => s.error);
  const markKeychain = useKeySourcesStore((s) => s.markKeychain);
  useEffect(() => {
    hookFocus();
    if (!useKeySourcesStore.getState().data) void useKeySourcesStore.getState().load();
  }, []);
  useOnIntegrationsChanged(() => void useKeySourcesStore.getState().load());
  return { data, error, markKeychain };
}
