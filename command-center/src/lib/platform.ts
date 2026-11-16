/**
 * Platform adapter — the ONLY place that knows whether we run inside the
 * Tauri desktop shell or as a plain PWA in a browser.
 *
 * Rule of thumb for feature code:
 *   - Anything needing secrets, the local filesystem, processes (docker,
 *     netbird, nvidia-smi) or outbound LLM calls goes through `native()`.
 *   - On the PWA those same features go through the Agentic OS gateway
 *     (the FastAPI backend on the desktop, reached over NetBird) — never
 *     by putting API keys in the browser.
 */

export type Platform = "desktop" | "pwa";

export const isTauri = (): boolean =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export const platform: Platform = isTauri() ? "desktop" : "pwa";

/** Invoke a Rust command. Throws on the PWA — guard with `isTauri()` or use a hook with a fallback. */
export async function native<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) throw new Error(`native command "${cmd}" is desktop-only`);
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

/** Typed contract for every Rust command exposed in src-tauri/src/lib.rs. Keep in sync. */
export interface NativeCommands {
  system_stats: { args: undefined; result: SystemStats };
  secret_set: { args: { provider: string; value: string }; result: void };
  secret_status: { args: { providers: string[] }; result: Record<string, boolean> };
  secret_delete: { args: { provider: string }; result: void };
  providers_list: { args: undefined; result: ProviderInfo[] };
  dispatch_chat: { args: { req: DispatchRequest }; result: DispatchResult };
  /** Returns raw audio bytes (mp3). */
  tts_synthesize: { args: { text: string }; result: ArrayBuffer };
  n8n_workflows: { args: undefined; result: string[] };
  n8n_trigger: { args: { name: string; payload: Record<string, unknown> }; result: string };
  docker_ps: { args: undefined; result: DockerContainer[] };
  netbird_status: { args: undefined; result: NetbirdStatus };
}

/** Send raw bytes to a Rust command that takes `tauri::ipc::Request` (e.g. WAV → stt_transcribe). */
export async function nativeRaw<T>(cmdName: "stt_transcribe", body: Uint8Array): Promise<T> {
  if (!isTauri()) throw new Error(`native command "${cmdName}" is desktop-only`);
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmdName, body);
}

/** Subscribe to a Rust → webview event. Returns an unsubscribe function. No-op on the PWA. */
export async function onNativeEvent(event: "voice-toggle", handler: () => void): Promise<() => void> {
  if (!isTauri()) return () => undefined;
  const { listen } = await import("@tauri-apps/api/event");
  return listen(event, handler);
}

export function cmd<K extends keyof NativeCommands>(
  name: K,
  ...args: NativeCommands[K]["args"] extends undefined ? [] : [NativeCommands[K]["args"]]
): Promise<NativeCommands[K]["result"]> {
  return native<NativeCommands[K]["result"]>(name, args[0] as Record<string, unknown> | undefined);
}

// ── Shared types (mirrors of the Rust structs, camelCase via serde) ──────────

export interface GpuStats {
  name: string;
  utilPct: number;
  vramUsedMb: number;
  vramTotalMb: number;
}

export interface SystemStats {
  cpuPct: number;
  memUsedMb: number;
  memTotalMb: number;
  hostname: string | null;
  gpu: GpuStats | null;
}

export type ProviderKind = "local" | "cloud" | "agentic-os" | "stt" | "tts" | "n8n";

export interface ProviderInfo {
  id: string;
  label: string;
  kind: ProviderKind;
  baseUrl: string;
  model: string;
  needsKey: boolean;
  hasKey: boolean;
  voice?: string;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export type Priority = "interactive" | "background";

export interface DispatchRequest {
  messages: ChatMessage[];
  priority: Priority;
  /** Force a provider id ("verifier" = the policy's verifier); otherwise the Rust routing policy decides. */
  provider?: string;
  /** Cap this request's timeout (seconds). */
  maxSecs?: number;
}

export interface DispatchResult {
  providerId: string;
  content: string;
  fellBack: boolean;
  reason: string;
  latencyMs: number;
}

export interface DockerContainer {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
}

export interface NetbirdStatus {
  connected: boolean;
  peersConnected: number;
  peersTotal: number;
  ip: string | null;
  raw: string | null;
}
