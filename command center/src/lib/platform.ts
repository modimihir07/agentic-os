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

import { recordIpc } from "./ipc-ring";

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
  secret_set: { args: { provider: string; value: string; slot?: "api" }; result: void };
  secret_status: { args: { providers: string[] }; result: Record<string, boolean> };
  secret_delete: { args: { provider: string; slot?: "api" }; result: void };
  bridge_get: { args: undefined; result: BridgeView };
  bridge_set: { args: { scope: BridgeScope; tier: BridgeTier }; result: BridgeView };
  pipelines_status: { args: undefined; result: PipelinesView };
  pipeline_run: { args: { instanceId: string; workflowId: string; approved?: boolean }; result: RunResult };
  pipeline_set_active: { args: { instanceId: string; workflowId: string; active: boolean; approved?: boolean }; result: boolean };
  pipelines_settings: { args: undefined; result: PipelinesSettings };
  pipelines_settings_update: { args: { patch: Partial<PipelinesConfig>; approved?: boolean }; result: PipelinesSettings };
  n8n_instance_add: { args: { label: string; baseUrl: string }; result: PipelinesSettings };
  trigger_gdrive_sync: { args: { approved?: boolean }; result: SyncResult };
  providers_list: { args: undefined; result: ProvidersView };
  providers_update: { args: { patch: ProviderPatch }; result: ProvidersView };
  provider_add: { args: { provider: NewProvider }; result: ProvidersView };
  provider_remove: { args: { id: string }; result: ProvidersView };
  policy_update: { args: { patch: PolicyPatch }; result: ProvidersView };
  /** Settings → Voice: edit one agent's roster row ("tony" is an alias of "general"). */
  agent_voice_update: { args: { role: string; patch: AgentVoicePatch }; result: ProvidersView };
  dispatch_chat: { args: { req: DispatchRequest }; result: DispatchResult };
  services_health: { args: undefined; result: ServiceHealth[] };
  provider_models: { args: { id: string }; result: string[] };
  gateway_ensure: { args: undefined; result: GatewayStatus };
  stt_configure: { args: { model?: string; language?: string }; result: string };
  /** Native full-duplex audio engine (src-tauri/src/audio). Events on "audio-engine". */
  audio_engine_devices: { args: undefined; result: AudioDevices };
  audio_engine_start: { args: { options?: AudioEngineStartOptions }; result: AudioEngineStatus };
  audio_engine_stop: { args: undefined; result: void };
  audio_engine_status: { args: undefined; result: AudioEngineStatus };
  /** Cut the assistant off now. False if it was already cut off. */
  audio_engine_barge_in: { args: undefined; result: boolean };
  /** Fake assistant turn (a tone) to test output and barge-in by talking over it. */
  audio_engine_test_tone: { args: { freqHz?: number; ms?: number }; result: void };
  /** Returns raw audio bytes (mp3 for Kokoro, wav for XTTS). `voice` overrides for previews;
   * `agent` (Part 3) picks a voice-roster entry when no explicit `voice` is given.
   * `previousText` (Part 6 §2) is the sentence spoken right before this one in the
   * same reply, for ElevenLabs prosody continuity; ignored by local engines. */
  tts_synthesize: { args: { text: string; voice?: string; agent?: string; previousText?: string }; result: ArrayBuffer };
  /** `engine` previews an engine's voices even when it isn't the current `policy.tts`. */
  tts_voices: { args: { engine?: string }; result: VoicesView };
  n8n_workflows: { args: undefined; result: WorkflowInfo[] };
  n8n_workflows_set: { args: { workflows: WorkflowInfo[] }; result: WorkflowInfo[] };
  n8n_trigger: { args: { name: string; payload: Record<string, unknown> }; result: string };
  /** Read-only workflows only (mutating ones are refused in Rust). */
  n8n_fetch: { args: { name: string; payload?: Record<string, unknown> }; result: unknown };
  n8n_discover: { args: { adopt?: boolean }; result: N8nDiscovery };
  docker_ps: { args: undefined; result: DockerContainer[] };
  netbird_status: { args: undefined; result: NetbirdStatus };
  // ── Agentic OS core ("Tony") ──
  os_config_get: { args: undefined; result: OsConfig };
  os_config_update: { args: { patch: OsConfigPatch }; result: OsConfig };
  os_identity: { args: undefined; result: string };
  os_secret_set: { args: { name: OsSecret; value: string }; result: void };
  os_secret_status: { args: undefined; result: Record<OsSecret, boolean> };
  /** Where each OS secret is resolved from (env → repo .env → keychain). Presence and source names only, never values. */
  os_secret_sources: { args: undefined; result: OsKeySources };
  os_secret_delete: { args: { name: OsSecret }; result: void };
  privacy_last_payload: { args: undefined; result: RedactionRecord | null };
  privacy_preview: { args: { text: string }; result: { redacted: string; replacements: Replacement[] } };
  droplet_test: { args: undefined; result: EndpointProbe[] };
  network_audit: { args: undefined; result: ListenFinding[] };
  gateway_token_rotate: { args: undefined; result: string };
  anythingllm_workspaces: { args: undefined; result: WorkspaceInfo[] };
  os_turn: { args: { req: OsTurnRequest }; result: OsTurnResult };
  /** Phase 2 "cut it": drop an in-flight os_turn (its LLM / sub-agent streams) by streamId. */
  os_turn_cancel: { args: { streamId: string }; result: void };
  overseer_ask: { args: { req: { question: string; transcript: ChatMessage[]; context: string; engine?: string } }; result: { answer: string; engine: string; latencyMs: number; redacted: boolean } };
  mcp_list_tools: { args: { refresh?: boolean }; result: ServerTools[] };
  /** Tool NAMES Tony's next turn would see (every tool of his servers / those offered to his LLM router). No secrets. */
  tony_tools_preview: { args: undefined; result: TonyToolsPreview };
  mcp_call: { args: { name: string; args: Record<string, unknown>; approved?: boolean; agent?: string }; result: string };
  mcp_sync_anythingllm: { args: undefined; result: AllmSyncReport };
  /** Which Gmail backend `gmail.*` tools use; credentials are set via `os_secret_set` (`gmail-script-id` / `gmail-script-key`). */
  gmail_status: { args: undefined; result: { configured: boolean; source: "script" | "n8n" | "none" } };
  /** Copies AnythingLLM Desktop's Gmail agent deployment into the keychain (values never reach the webview). */
  gmail_import_anythingllm: { args: undefined; result: { imported: boolean; detail: string } };
  /** Only after the confirmation card: returns `PERMISSION_REQUIRED:gmail-draft` unless `approved`. */
  gmail_create_draft: { args: { to: string; subject: string; body: string; approved?: boolean }; result: string };
  /** Opens Spotify's consent page in the system browser and returns its URL (fallback link);
   * the outcome arrives as the `spotify-auth` event. */
  spotify_auth_start: { args: undefined; result: { url: string } };
  /** `configured` = SPOTIFY_CLIENT_ID is in the env / repo .env; `connected` = a refresh token is stored. */
  spotify_status: { args: undefined; result: SpotifyStatus };
  spotify_disconnect: { args: undefined; result: void };
  spotify_now_playing: { args: undefined; result: SpotifyNowPlaying };
  /** `value`: volume → number (absolute %) or "+N" / "-N"; shuffle → boolean / "on" / "off" (omit to toggle).
   * `approved` only matters when the MCP permission tier is Ask. Resolves to a short reply ("Paused Spotify."). */
  spotify_control: { args: { action: SpotifyAction; value?: number | string | boolean; approved?: boolean }; result: string };
  spotify_play: { args: { query: string; kind?: "track" | "artist" | "album" | "playlist"; approved?: boolean }; result: string };
  spotify_play_uri: { args: { uri: string; approved?: boolean }; result: string };
  spotify_recent: { args: undefined; result: SpotifyItem[] };
  spotify_playlists: { args: undefined; result: SpotifyItem[] };
  /** The one Spotify grammar (Rust `spotify_intent::parse`): pure, no gate, no network. Null = not a Spotify line. */
  spotify_parse: { args: { text: string; osName?: string }; result: SpotifyIntent | null };
  /** Run one Spotify tool. Kill switch, server on/read-only, `may_read` (reads) or the MCP tier +
   * destructive gate (writes) apply in Rust. Resolves to a speakable reply (no IDs / URIs). */
  spotify_tool: { args: { name: SpotifyToolName; args?: Record<string, unknown>; approved?: boolean }; result: string };
  skills_scan: { args: undefined; result: SkillInfo[] };
  memory_harvest: { args: { req: { month?: string } }; result: LedgerEntry };
  memory_flush: { args: { req: { month: string; includeLocal?: boolean; approved?: boolean } }; result: string[] };
  memory_ledger: { args: undefined; result: LedgerEntry[] };
  memory_mount: { args: { req: { month: string; target: "local" | "droplet"; approved?: boolean } }; result: LedgerEntry };
  memory_unmount: { args: { req: { month: string; target: "local" | "droplet" } }; result: LedgerEntry };
  memory_export: { args: { month: string; kind: "raw" | "summary" | "dataset" }; result: string };
  market_candles: { args: { symbol: string; interval: string; range: string }; result: import("./cc-api").MarketData };
  idea_capture: { args: { text: string }; result: { idea: Idea & { id: string }; reply: string; steps: OsStep[] } };
  idea_pipeline_run: { args: { ideaId: string }; result: { cardId: string; hasHtml: boolean; steps: OsStep[] } };
  playplace_iterate: { args: { cardId: string; notes: string; target: "designer" | "coder" }; result: PlayCard };
  playplace_approve: { args: { cardId: string }; result: PlayCard };
  playplace_commit: { args: { cardId: string }; result: PlayCard };
  comms_whatsapp: { args: { action: "chats" | "messages" | "contacts"; args: Record<string, unknown> }; result: string };
  comms_whatsapp_send: { args: { recipient: string; message: string; approved?: boolean }; result: string };
  cli_status: { args: undefined; result: CliStatus[] };
  cli_install: { args: { name: string; approved?: boolean }; result: string };
  pipeline_resume: { args: { checkpoint: string; offload?: string }; result: { cardId: string } };
  droplet_link: { args: undefined; result: DropletLink };
  gpu_slot_view: { args: undefined; result: SlotView };
  model_lab_list: { args: undefined; result: LabModel[] };
  model_bench: { args: { model: string; context?: number }; result: BenchResult };
  model_use: { args: { model: string }; result: string[] };
  // ── System Map dev task queue (devqueue.db in the app config dir; works without the gateway) ──
  /** Category / priority are inferred from the text when omitted. `trace` (a failing step, for
   * `kind: "fix"`) and `ui` (whitelisted `DevUiState` keys) go into the Rust-built, secret-scrubbed snapshot. */
  dev_task_add: {
    args: { title: string; category?: DevTaskCategory; priority?: DevTaskPriority; body?: string; kind?: DevTaskKind; source?: DevTaskSource; trace?: DevTraceStep; ui?: DevUiState };
    result: DevTask;
  };
  dev_task_list: { args: { status?: DevTaskStatus; category?: DevTaskCategory }; result: DevTask[] };
  dev_task_update: { args: { id: string; status?: DevTaskStatus; priority?: DevTaskPriority; title?: string; category?: DevTaskCategory }; result: DevTask };
  /** Resolves `false` when no such task existed. */
  dev_task_delete: { args: { id: string }; result: boolean };
  /** Writes `<repo>/memory/session_handoffs/YYYY-MM-DD-HHMM.md` and returns its Markdown (copy it to the clipboard). */
  dev_brief_export: { args: undefined; result: DevBriefExport };
  // ── System Map introspection (read-only, no LLM, secret-scrubbed in Rust) ──
  /** Cached 10 s in Rust; `deep: true` re-probes and re-lists every external MCP server. */
  system_introspect: { args: { deep?: boolean }; result: SystemSnapshot };
  app_uptime: { args: undefined; result: AppUptime };
}

/**
 * Send raw bytes to a Rust command that takes `tauri::ipc::Request`
 * (WAV → stt_transcribe, a voice file → tts_voice_upload).
 */
export async function nativeRaw<T>(cmdName: "stt_transcribe" | "tts_voice_upload", body: Uint8Array, headers?: Record<string, string>): Promise<T> {
  if (!isTauri()) throw new Error(`native command "${cmdName}" is desktop-only`);
  const { invoke } = await import("@tauri-apps/api/core");
  return timed(cmdName, invoke<T>(cmdName, body, headers ? { headers } : undefined));
}

/** Dev X-Ray IPC ring: the command name, duration and outcome of each desktop invoke (never its args). */
function timed<T>(name: string, p: Promise<T>): Promise<T> {
  if (!isTauri()) return p;
  const t0 = performance.now();
  p.then(
    () => recordIpc(name, performance.now() - t0, true),
    () => recordIpc(name, performance.now() - t0, false),
  );
  return p;
}

/** Subscribe to a Rust → webview event. Returns an unsubscribe function. No-op on the PWA. */
export async function onNativeEvent<P = unknown>(event: "voice-toggle" | "memory-progress" | "pipeline-step" | "pipeline-failed" | "gpu-slot" | "droplet-status" | "tony-token" | "tts-fallback" | "spotify-auth" | "spotify-session" | "spotify-reauth" | "tools-changed" | "audio-engine" | "os-trace", handler: (payload: P) => void): Promise<() => void> {
  if (!isTauri()) return () => undefined;
  const { listen } = await import("@tauri-apps/api/event");
  return listen<P>(event, (e) => handler(e.payload));
}

export function cmd<K extends keyof NativeCommands>(
  name: K,
  ...args: NativeCommands[K]["args"] extends undefined ? [] : [NativeCommands[K]["args"]]
): Promise<NativeCommands[K]["result"]> {
  return timed(name, native<NativeCommands[K]["result"]>(name, args[0] as Record<string, unknown> | undefined));
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

export type ProviderKind = "local" | "cloud" | "agentic-os" | "stt" | "tts" | "n8n" | "integration";
export const CHAT_KINDS: ProviderKind[] = ["local", "cloud", "agentic-os"];

export interface ProviderInfo {
  id: string;
  label: string;
  kind: ProviderKind;
  baseUrl: string;
  model: string;
  needsKey: boolean;
  hasKey: boolean;
  voice?: string;
  engine?: string;
  language?: string;
  modelsDir?: string;
  voicesDir?: string;
  /** STT: Whisper vocabulary-biasing prompt in effect ("" = none). */
  sttPrompt?: string;
  custom: boolean;
}

export interface Policy {
  gpuUtilMax: number;
  vramMaxPct: number;
  primaryLocal: string;
  fallbackCloud: string;
  chain: string[];
  verifier: string;
  stt: string;
  tts: string;
}

/** Part 3: one agent's voice ("general" = Tony). `voice`/`model` unset =
 * use the matching provider's own `voice`/`model`. */
export interface AgentVoice {
  engine: "elevenlabs" | "kokoro";
  voice?: string;
  model?: string;
  autoSpeak: boolean;
}
export type AgentVoicePatch = Partial<Pick<AgentVoice, "engine" | "voice" | "model" | "autoSpeak">>;

export interface ProvidersView {
  providers: ProviderInfo[];
  policy: Policy;
  /** Part 3: the voice roster, by role id ("general" = Tony); missing role = no override. */
  agentVoices: Record<string, AgentVoice>;
}

export type ProviderPatch = { id: string } & Partial<Pick<ProviderInfo, "label" | "baseUrl" | "model" | "voice" | "language" | "engine" | "modelsDir" | "voicesDir" | "sttPrompt">>;
export type NewProvider = Pick<ProviderInfo, "id" | "label" | "kind" | "baseUrl" | "model" | "needsKey">;
export type PolicyPatch = Partial<Pick<Policy, "chain" | "verifier" | "stt" | "tts" | "gpuUtilMax" | "vramMaxPct">>;

export interface ServiceHealth {
  id: string;
  label: string;
  kind: string;
  up: boolean;
  latencyMs: number;
  detail: string;
  /** Switched off on purpose (droplet switch, kill switch, LOCAL ONLY) — not a fault. */
  manual?: boolean;
}

export interface GatewayStatus {
  up: boolean;
  started: boolean;
  url: string;
  detail: string;
}

export interface VoicesView {
  provider: string;
  engine: string;
  current: string | null;
  voicesDir: string | null;
  voices: { id: string; source: "server" | "custom"; file: string | null; label: string | null; category: string | null }[];
  serverError: string | null;
  /** Cloud engines: where the API key was found (never the key itself). */
  keySource: "env" | "env-file" | "keychain" | "missing" | null;
}

export interface WorkflowInfo {
  name: string;
  path: string;
  mutating: boolean;
  description?: string | null;
}

// ── Permission Bridge + n8n pipelines + Drive sync ──────────────────────────

export type BridgeScope = "read" | "write" | "execute" | "network";
export type BridgeTier = "allow" | "ask" | "deny";
export interface BridgeView {
  policy: Record<BridgeScope, BridgeTier>;
  logDir: string | null;
}

export type PipelineStatus = "success" | "error" | "running" | "idle";
export interface WorkflowStatus {
  workflowId: string;
  name: string;
  instanceId: string;
  instanceLabel: string;
  isActive: boolean;
  lastStatus: PipelineStatus;
  lastRunTimestamp: string | null;
  durationMs: number | null;
  runnable: boolean;
  tags: string[];
}
export interface InstanceStatus {
  id: string;
  label: string;
  baseUrl: string;
  status: "online" | "offline" | "unauthorized" | "no-key" | "error";
  detail: string;
  latencyMs: number;
  hasApiKey: boolean;
  workflows: WorkflowStatus[];
}
export interface SyncResult {
  status: "synced" | "up-to-date" | "failed" | "offline" | "not-configured" | "busy";
  at: number;
  files: number;
  bytes: number;
  skippedLarge: number;
  detail: string;
  trigger: string;
}
export interface PipelinesView {
  online: boolean;
  activeSessions: number;
  running: number;
  instances: InstanceStatus[];
  pollIntervalSeconds: number;
  lastSync: SyncResult | null;
  polledAt: number;
}
export interface RunResult {
  status: "completed" | "dispatched" | "error";
  httpStatus: number | null;
  latencyMs: number;
  detail: string;
}
export interface PipelinesConfig {
  pollIntervalSeconds: number;
  gdriveSyncWebhookUrl: string;
  gdriveTrackedPaths: string[];
  autoSyncEnabled: boolean;
  autoSyncHours: number;
  syncOnExit: boolean;
}
export interface PipelinesSettings extends PipelinesConfig {
  instances: { id: string; label: string; baseUrl: string; hasApiKey: boolean; custom: boolean }[];
  resolvedPaths: { path: string; exists: boolean }[];
}

export interface N8nDiscovery {
  found: boolean;
  container: string | null;
  image: string | null;
  status: string | null;
  url: string | null;
  healthy: boolean;
  adopted: boolean;
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
  /** The prompt left the machine through the privacy diffuser. */
  redacted?: boolean;
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

// ── Agentic OS core ──────────────────────────────────────────────────────────

export type Tier = "allow" | "ask" | "deny";
export type ComputeMode = "local" | "hybrid" | "cloud";
export type OsSecret =
  | "anthropic"
  | "gemini"
  | "brave"
  | "twelvedata"
  | "vault"
  | "gateway-token"
  | "anythingllm-remote"
  | "gmail-script-id"
  | "gmail-script-key"
  | "github-pat"
  | "sentry-token"
  | "agentmail-key";
/** Where a credential was found (Rust `envfile::KeySource`). */
export type KeySourceKind = "env" | "env-file" | "keychain" | "missing";
export interface OsKeyStatus {
  source: KeySourceKind;
  /** The env var that overrides this secret; null = keychain-only. */
  envVar: string | null;
  /** A keychain entry exists (deletable from Settings). */
  keychain: boolean;
  /** Gmail only: part of the ID/key pair is set, but not both from one place. */
  pairIncomplete?: boolean;
}
export interface OsKeySources {
  keys: Record<OsSecret, OsKeyStatus>;
  /** Path of the repo-root .env that is consulted. */
  envFile: string;
  envFileFound: boolean;
}
export type OverseerEngine = "claude-cli" | "claude-api" | "gemini-cli" | "gemini-api" | "droplet" | "local";

export interface AgentTriggers {
  names: string[];
  domains: string[];
}
export interface RoutingConfig {
  autoSwitch: boolean;
  agents: Record<string, AgentTriggers>;
}

export interface McpServer {
  id: string;
  name: string;
  transport: "builtin" | "stdio" | "http";
  command: string;
  args: string[];
  env: Record<string, string>;
  url: string;
  enabled: boolean;
  builtin: boolean;
  description: string;
  /** Part 2 per-agent grants: `null`/missing/containing `"all"` = every agent.
   * Tony (general/tony) always has every enabled server regardless of this. */
  agents?: string[] | null;
  /** stdio: seconds to wait for `initialize` (5–600). Unset = 120 s for npx/uvx/uv/pnpm/pnpx/bunx/pipx/serena, else 45 s. A value above 60 also raises the tool-call timeout (default 60 s; never lowered). */
  timeoutSecs?: number | null;
  /** stdio: absolute working folder. Unset = the repo (gateway workdir). */
  cwd?: string | null;
  /** Its mutating tools (writes, deletes, edits…) are hidden and refused for every caller. Omitted = false. */
  readOnly?: boolean;
}

export interface AllmSyncReport {
  added: string[];
  kept: string[];
  skipped: string[];
  /** Existing entries whose invalid "streamable-http" type was repaired. */
  fixed?: string[];
}

export interface OsConfig {
  osName: string;
  wakeWords: string[];
  identityPath: string;
  rootDirective: boolean;
  compute: { mode: ComputeMode; vramThresholdPct: number; heavyContextChars: number; deepThinking: boolean };
  droplet: { enabled: boolean; host: string; qdrantUrl: string; n8nUrl: string; modelUrl: string; anythingllmUrl: string };
  anythingllm: { baseUrl: string; workspaces: Record<string, string>; timeoutSecs: number };
  skills: { dir: string; grants: Record<string, string[]> };
  mcps: McpServer[];
  routing: RoutingConfig;
  fsRoots: string[];
  permissions: { delegation: Tier; mcp: Tier; filesystem: Tier; cloud: Tier };
  privacy: { diffuser: boolean; networkLock: boolean; killSwitch: boolean; destructiveGate: boolean; sensitiveTerms: string[] };
  overseer: { engine: OverseerEngine; claudeModel: string; geminiModel: string; autoEscalate: boolean; manualMode: boolean };
  scheduler: SchedulerConfig;
  memory: {
    storage: "local" | "droplet" | "hybrid";
    autoMonthly: boolean;
    autoFlush: boolean;
    vaultDir: string;
    datasetFormat: "chatml" | "alpaca" | "sharegpt";
    mountWorkspace: string;
    cacheCollections: string[];
    lastAutoMonth: string;
  };
}

/** Top-level keys replace; object sections merge one level deep (Rust side). */
export type OsConfigPatch = {
  [K in keyof OsConfig]?: OsConfig[K] extends unknown[] ? OsConfig[K] : OsConfig[K] extends object ? Partial<OsConfig[K]> : OsConfig[K];
};

export interface Replacement {
  token: string;
  kind: string;
  original: string;
}
export interface RedactionRecord {
  at: number;
  destination: string;
  payload: ChatMessage[];
  replacements: Replacement[];
}
export interface EndpointProbe {
  id: string;
  label: string;
  url: string;
  up: boolean;
  detail: string;
  latencyMs: number;
}
export interface ListenFinding {
  port: number;
  service: string;
  bind: string;
  exposed: boolean;
  fix: string;
}

export interface SchedulerConfig {
  profile: "sequential" | "hybrid" | "parallel";
  tonyPriorityPct: number;
  maxConcurrency: number;
  offloadPct: number;
  offloadEngine: "claude-cli" | "gemini-cli" | "llm-cli" | "claude-api" | "gemini-api" | "droplet";
  historyTurns: number;
}
export type DevTaskCategory = "mcp" | "auth" | "ui" | "backend" | "routing";
export type DevTaskStatus = "Pending" | "Queued" | "In Progress" | "Done";
export type DevTaskKind = "task" | "note" | "fix";
export type DevTaskSource = "typed" | "voice" | "trace" | "phone";
/** 0 = urgent … 3 = low. */
export type DevTaskPriority = 0 | 1 | 2 | 3;
export const DEV_TASK_CATEGORIES: DevTaskCategory[] = ["mcp", "auth", "ui", "backend", "routing"];
export const DEV_TASK_STATUSES: DevTaskStatus[] = ["Pending", "Queued", "In Progress", "Done"];
/** One hop of a routing trace, as attached to a `fix` (no arguments, results or secrets). */
export interface DevTraceStep {
  traceId: string;
  seq: number;
  hop: string;
  zone: string;
  label: string;
  ok: boolean;
  ms: number;
  error?: string;
  at: number;
}
/** System Map routing trace (plan §2). Rust emits router/rules/memory/model/tool; the webview adds the rest. */
export type TraceHop = "input" | "vad" | "stt" | "router" | "rules" | "memory" | "model" | "tool" | "tts" | "ui";
export type TraceZone = "cockpit" | "engine" | "ecu" | "cargo" | "exhaust";
/** `os-trace` event payload (agents::os_turn, mcp::call_tool) and the webview's own hops.
 * Labels, timings and error text only — never arguments, results or secrets. `at` = unix ms. */
export interface TraceStep extends DevTraceStep {
  hop: TraceHop;
  zone: TraceZone;
  /** Model hops: tokens/s of the streamed reply, when it could be measured. */
  tps?: number;
}
/** The only UI keys Rust keeps in a snapshot (scalars only; anything else is dropped). */
export interface DevUiState {
  voiceState?: string;
  voiceChannel?: string;
  listening?: boolean;
  section?: string;
  thread?: string;
  sttEngine?: string;
  ttsEngine?: string;
  viewMode?: string;
}
/** What the OS looked like when a task was logged. Built in Rust from cached data, secret-scrubbed. */
export interface DevContextSnapshot {
  at?: number;
  /** Compact numbers from the last `system_introspect` (when one ran in the last 2 minutes). */
  system?: Partial<Record<"uptimeSecs" | "cpuPct" | "memUsedMb" | "memTotalMb" | "gpuUtilPct" | "vramUsedMb" | "vramTotalMb" | "servicesUp" | "servicesTotal" | "skills" | "storesOk" | "storesTotal", number>>;
  services?: { id?: string; label?: string; port?: number; up?: boolean; latencyMs?: number; detail?: string; manual?: boolean }[];
  /** Unix secs of the `services_health` probe the services came from (absent when from introspection). */
  servicesAt?: number;
  bus?: { id?: string; name?: string; transport?: string; status?: string; error?: string | null; lastError?: string; tools?: number; lastMs?: number; lastOk?: boolean }[];
  agents?: { active?: string[]; queuedForeground?: number; queuedBackground?: number; capacity?: number; roster?: Record<string, string | number | boolean>[] };
  ui?: DevUiState;
  git?: { branch: string | null; head: string | null };
  trace?: Partial<DevTraceStep>;
}
/** AnythingLLM workspace; null models = AnythingLLM's system default. */
export interface WorkspaceInfo {
  slug: string;
  name: string;
  threads: number;
  chatProvider: string | null;
  chatModel: string | null;
  agentProvider: string | null;
  agentModel: string | null;
}

// ── System Map snapshot (`system_introspect`) ──
// Every nullable field means "no live source": show "—" with the matching *Note / error as the tooltip.

export interface AppUptime {
  /** Unix ms. */
  startedAt: number;
  uptimeSecs: number;
}
export interface SnapHost {
  cpuPct?: number;
  memUsedMb?: number;
  memTotalMb?: number;
  hostname?: string | null;
  gpu?: GpuStats | null;
  cpuBrand: string | null;
  cpuThreads: number;
  /** Why `gpu` is null. */
  gpuNote?: string;
  /** Set when sysinfo itself failed (then the numbers above are absent). */
  error?: string;
}
/** A loopback service probe (3 s timeout). `id` "lmstudio-1234" = LM Studio's default port, probed separately. */
export interface SnapService extends ServiceHealth {
  port: number | null;
}
export interface SnapChainLink {
  id: string;
  label: string;
  kind: string;
  model: string;
  local: boolean;
}
export interface SnapAgent {
  /** "general" = Tony. */
  role: string;
  label: string;
  slug: string;
  /** null = AnythingLLM unreachable / no key (see `agentsNote`); false = slug not found there. */
  found: boolean | null;
  threads: number | null;
  chatProvider: string | null;
  chatModel: string | null;
  agentProvider: string | null;
  agentModel: string | null;
  /** Holds the GPU slot right now (from the `gpu-slot` labels). */
  active: boolean;
}
export interface SnapRules {
  identity: {
    path: string;
    bytes: number | null;
    modifiedMs: number | null;
    lines: number;
    headings: number;
    bullets: number;
    /** `##` titles. */
    sections: string[];
    /** Chars of it that go into the system prompt (capped at 6000). */
    promptChars: number;
  } | null;
  identityError: string | null;
  rootDirective: boolean;
  /** Bullets in HANDOFF.md's Guardrails section. */
  guardrails: number | null;
  guardrailsPath: string;
  guardrailsNote: string | null;
}
export interface SnapSkillRoot {
  path: string;
  exists: boolean;
  count: number;
  truncated: boolean;
  /** The same folder reached another way (junction); its skills are counted under this path. */
  sameAs?: string;
}
export interface SnapSkill {
  name: string;
  folder: string;
  description: string;
  path: string;
  root: string;
  /** Agents it's granted to (os.json `skills.grants`, by name or folder). */
  agents: string[];
}
export interface SnapSkills {
  total: number;
  roots: SnapSkillRoot[];
  items: SnapSkill[];
  /** Granted in os.json but not found on disk. */
  grantedMissing: string[];
}
export interface SnapLoop {
  id: "inbox" | "whisper" | "local-fit" | "droplet";
  label: string;
  intervalSecs: number;
  source: string;
  /** Unix ms; null = hasn't run since the app started. */
  lastRun: number | null;
  lastOk: boolean | null;
  detail: string | null;
  runs: number;
  overdue: boolean;
}
export interface SnapSchedulerJob {
  id: string | null;
  name: string | null;
  skill: string | null;
  cron: string | null;
  enabled: boolean | null;
  lastRun: string | null;
  nextRun: string | null;
}
export interface SnapN8nInstance {
  id: string;
  label: string;
  /** online | offline | unauthorized | no-key | error | skipped */
  status: string;
  detail: string;
  workflows: { id?: string; name: string; active: boolean; lastStatus: string; lastRun: string | null }[];
}
export interface SnapRoutines {
  loops: SnapLoop[];
  /** Gateway `/api/scheduler/jobs`; null when the gateway didn't answer (see `schedulerNote`). */
  schedulerJobs: SnapSchedulerJob[] | null;
  schedulerNote: string | null;
  /** providers.json `n8nWorkflows` (names only; webhook paths stay in Rust). */
  n8nConfigured: { name: string; mutating: boolean }[];
  n8n: SnapN8nInstance[];
  n8nNote: string | null;
}
export interface SnapStore {
  id: "devqueue" | "cc" | "memory" | "anythingllm" | "training-logs" | "knowledge-graph";
  label: string;
  kind: "sqlite" | "jsonl" | "json";
  path?: string;
  exists: boolean;
  bytes?: number | null;
  modifiedMs?: number | null;
  writable?: boolean | null;
  health: "ok" | "missing" | "error";
  error?: string;
  /** rows null = count failed. */
  tables: { name: string; rows: number | null }[];
  tablesTruncated?: boolean;
  /** cc: ragVectors, vaultItems · training-logs: todayLines, files · knowledge-graph: entities. */
  metrics: Partial<Record<"ragVectors" | "vaultItems" | "todayLines" | "files" | "entities", number | null>>;
}
/** "starting" = a listing / cold start is running in the background; "needs_token" = muted, no network call is made. */
export type BusStatus = "ok" | "off" | "needs_token" | "auth_failed" | "starting" | "error" | "unknown";
export interface SnapBus {
  id: string;
  name: string;
  transport: "builtin" | "stdio" | "http" | string;
  /** From cached data only; "unknown" = not listed in the last 10 min (run a deep scan). */
  status: BusStatus;
  error: string | null;
  /** null = unknown (not listed recently, or off). */
  tools: number | null;
  /** Present once the server has been called since the app started. */
  calls?: number;
  failures?: number;
  lastMs?: number;
  lastOk?: boolean;
  lastError?: string | null;
  /** Unix secs. */
  lastAt?: number;
  /** Credential source, names only: brave "env"|"keychain"|"none"; gmail also "n8n:<wf>"; spotify "env + keychain"|"none". */
  source?: string;
}
export interface SnapSummary {
  uptimeSecs: number;
  cpuPct: number | null;
  memUsedMb: number | null;
  memTotalMb: number | null;
  gpuUtilPct: number | null;
  vramUsedMb: number | null;
  vramTotalMb: number | null;
  servicesUp: number;
  servicesTotal: number;
  skills: number;
  storesOk: number;
  storesTotal: number;
}
export interface SystemSnapshot {
  /** Unix ms when built. */
  at: number;
  deep: boolean;
  tookMs: number;
  uptimeSecs: number;
  host: SnapHost;
  services: SnapService[];
  /** Tony's provider failover chain (providers.json `policy.chain`). */
  chain: SnapChainLink[];
  agents: SnapAgent[];
  agentsNote: string | null;
  slot: SlotView;
  rules: SnapRules;
  skills: SnapSkills;
  routines: SnapRoutines;
  stores: SnapStore[];
  bus: SnapBus[];
  summary: SnapSummary;
}

export interface DevTask {
  id: string;
  title: string;
  category: DevTaskCategory;
  priority: DevTaskPriority;
  status: DevTaskStatus;
  contextSnapshot: DevContextSnapshot;
  kind: DevTaskKind;
  body: string;
  source: DevTaskSource;
  /** Unix milliseconds. */
  createdAt: number;
  updatedAt: number;
}
export interface DevBriefExport {
  markdown: string;
  /** Absolute path of the written file. */
  path: string;
}
export interface SlotView {
  active: string[];
  queuedForeground: number;
  queuedBackground: number;
  capacity: number;
}
export interface DropletLink {
  state: "connected" | "checking" | "reconnecting" | "offline" | "disabled";
  detail: string;
  latencyMs: number;
  at: number;
}
export interface CliStatus {
  name: string;
  label: string;
  installed: boolean;
  version: string | null;
  path: string | null;
  error: string | null;
  canInstall: boolean;
  how: string;
}
export interface PipelineFailed {
  pipelineId: string;
  ideaId: string;
  title: string;
  stage: string;
  error: string;
  checkpoint: string | null;
}

export interface OsTurnRequest {
  streamId?: string;
  text: string;
  role: string;
  explicit?: boolean;
  /** How the caller already classified this turn ("Named" | "Domain" | "Tab" | "Llm" | "Default"). */
  routeKind?: string;
  routeReason?: string;
  history?: ChatMessage[];
  context?: string;
  approved?: boolean;
  /** System Map trace id the turn's `os-trace` steps join (`[A-Za-z0-9_:-]`, ≤ 64 chars). */
  traceId?: string;
  /** The caller can raise an approval card: a Spotify write held by the Ask tier comes back as
   * `OsTurnResult.pendingSpotify` instead of a failure note (voice / typed `osRun` only). */
  askCards?: boolean;
  /** A Gabagool cue is playing: Rust won't offer `spotify.volume` for a bare volume line. */
  cuePlaying?: boolean;
}
export interface OsStep {
  kind: "delegate" | "reply" | "tool" | "step-in" | "error" | "overseer" | "verify";
  from: string;
  to: string;
  text: string;
  ok: boolean;
  ms: number;
}
export interface PipelineStepEvent extends OsStep {
  pipelineId: string;
  ideaId: string | null;
  cardId: string | null;
  stage: string;
  pct: number;
  thread: string;
}

export interface Idea {
  title: string;
  idea: string;
  summary?: string;
  tasks: { id: string; text: string; done: boolean }[];
  spec?: Record<string, unknown>;
  status: "captured" | "prototyping" | "staged" | "approved" | "archived";
  cardId?: string;
}

export interface PlayCard {
  id: string;
  title: string;
  idea?: string;
  ideaId?: string;
  brief?: string;
  blueprint?: string;
  buildPrompt?: string;
  buildPlan?: string;
  coderOutput?: string;
  html?: string;
  hasHtml?: boolean;
  status: "staged" | "building" | "approved" | "committed" | "archived";
  versions?: { at: number; by: string; notes: string }[];
  vaultPath?: string;
  _updated?: number;
}

export interface OsTurnResult {
  answer: string;
  steps: OsStep[];
  providerId: string;
  delegatedTo: string | null;
  tool: string | null;
  latencyMs: number;
  reason: string;
  redacted: boolean;
  commsThread?: string;
  /** Final role this turn was routed to (after the Rust safety net, if it fired). */
  routedRole: string;
  routeReason: string;
  /** "Named" | "Domain" | "Tab" | "Llm" | "Default". */
  routeKind: string;
  /** Only with `askCards`: the Spotify write the gate held back (`answer` is then ""). Approve it
   * with `spotify_tool(name, args, approved: true)` — never by re-running the turn. */
  pendingSpotify?: PendingSpotifyCall;
}

export interface ToolInfo {
  name: string;
  description: string;
  server: string;
  args: string[];
}
export interface ServerTools {
  id: string;
  name: string;
  enabled: boolean;
  ok: boolean;
  error: string | null;
  tools: ToolInfo[];
  status: "ok" | "off" | "needs_token" | "auth_failed" | "starting" | "error";
  /** A remote server that takes a token: where it's read from (`.env` key first, then this keychain secret). */
  auth: { secret: OsSecret; env: string; label: string } | null;
}

/** Canonical Spotify tool names, in Rust `spotify_intent::ALL_TOOLS` order (spotify-tools-sync.test.ts keeps them equal). */
export const SPOTIFY_TOOL_NAMES = [
  "spotify.now_playing", "spotify.get_queue", "spotify.recently_played", "spotify.top_items",
  "spotify.list_playlists", "spotify.get_playlist_tracks",
  "spotify.play", "spotify.pause", "spotify.resume", "spotify.next", "spotify.previous",
  "spotify.seek", "spotify.restart_track", "spotify.volume", "spotify.shuffle", "spotify.repeat",
  "spotify.transfer_device", "spotify.queue_add",
  "spotify.create_playlist", "spotify.add_to_playlist", "spotify.remove_from_playlist",
  "spotify.like_track", "spotify.unlike_track",
] as const;
export type SpotifyToolName = (typeof SPOTIFY_TOOL_NAMES)[number];
/** `spotify_parse` result: what a line asks Spotify to do. */
export interface SpotifyIntent {
  /** A tool name, or the grammar-only "spotify.reconnect" (runs `connectSpotify`, never an MCP tool). */
  tool: SpotifyToolName | "spotify.reconnect";
  /** Already normalised by Rust (`normalize_args`). */
  args: Record<string, unknown>;
  /** Card / read-back text, no IDs ("Play Bilmuri on Spotify"). */
  summary: string;
  /** A write (needs the MCP tier); false for reads and reconnect. */
  mutating: boolean;
  /** The line named Spotify ("… on spotify") — a cue phrase can't take it. */
  explicit: boolean;
}
/** A Spotify write the Rust tool path wanted but the tier/destructive gate held back (D14). */
export interface PendingSpotifyCall {
  name: SpotifyToolName;
  args: Record<string, unknown>;
  /** Card text, no IDs: "Remove Tell Me from your Late Night playlist". */
  summary: string;
  /** The exact gate error, e.g. "PERMISSION_REQUIRED:mcp" | "PERMISSION_REQUIRED:destructive". */
  required: string;
}
export type SpotifyAction = "play" | "pause" | "resume" | "next" | "previous" | "volume" | "shuffle" | "seek" | "repeat";
export interface SpotifyStatus {
  configured: boolean;
  connected: boolean;
  account: string | null;
  /** A token is stored but Spotify refuses it (e.g. the app owner needs Premium). */
  problem: string | null;
  /** How to act on `problem`: only "reauth" needs a new sign-in. */
  problemKind: SpotifyProblemKind | null;
  /** Core scope names the stored grant lacks ([] when unknown). */
  missingScopes: string[];
  /** The consent predates the current scope set or misses a scope: a consent page is offered / needed. */
  reauthPending: boolean;
  /** Days left in Spotify's 6-month sign-in window, when known. */
  expiresInDays: number | null;
}
/** "reauth": only a new sign-in helps · "owner_premium": the app owner's account needs Premium
 *  (reconnecting won't help) · "premium": this account needs Premium · "allowlist": this account
 *  isn't on the app's Users Management list (development mode) · "transient": retry later. */
export type SpotifyProblemKind = "reauth" | "owner_premium" | "premium" | "allowlist" | "transient";
/** Payload of the `spotify-reauth` event: Rust opened a consent page on its own. `url` is the
 * authorize URL (no secret); `silent` = the tab may close itself with no click. */
export interface SpotifyReauthEvent {
  reason: "scopes" | "refused" | "expired" | "renew";
  url: string;
  silent: boolean;
}
/** Payload of the `spotify-session` event: a background token refresh found the sign-in dead. */
export interface SpotifySessionEvent {
  connected: boolean;
  kind: SpotifyProblemKind;
}
/** Payload of the `tools-changed` event (Spotify connected / disconnected / revoked, MCP registry saved). */
export interface ToolsChangedEvent {
  reason: string;
}
export interface TonyToolsPreview {
  all: string[];
  routerOffered: string[];
  spotifyReady: boolean;
}
/** `track` is null when nothing is playing (Spotify answered 204). */
export interface SpotifyNowPlaying {
  isPlaying: boolean;
  track: string | null;
  artists: string[];
  album: string | null;
  artUrl: string | null;
  progressMs: number;
  durationMs: number;
  device: string | null;
  volume: number | null;
  shuffle: boolean;
  uri: string | null;
}
/** A quick-select row (recent track or playlist); play it with `spotify_play_uri`. */
export interface SpotifyItem {
  uri: string;
  title: string;
  subtitle: string;
  artUrl: string | null;
}
/** Payload of the `spotify-auth` event. */
export interface SpotifyAuthEvent {
  ok: boolean;
  error?: string;
  account?: string | null;
}
export interface SkillInfo {
  name: string;
  description: string;
  path: string;
  kind: "skill" | "md" | "json";
  agents: string[];
}
export interface LedgerEntry {
  id: string;
  month: string;
  createdAt: number;
  sha256: string;
  verified: boolean;
  encrypted: boolean;
  records: number;
  pairs: number;
  summaryTokens: number;
  agents: string[];
  sources: Record<string, number>;
  files: Record<string, string>;
  mounts: { target: "local" | "droplet"; workspace: string; location: string; at: number }[];
  flushedAt: number | null;
  condensedBy: string;
  notes: string[];
  topics: string[];
}

export interface LabModel {
  key: string;
  name: string;
  params: string;
  quant: string;
  sizeGb: number;
  vision: boolean;
  loaded: boolean;
  context: number;
  fit: string;
  tony: boolean;
}
export interface BenchResult {
  model: string;
  context: number;
  loadMs: number;
  firstTokenMs: number;
  tokensPerSec: number;
  vramUsedGb: number;
  vramTotalGb: number;
  reply: string;
  error: string | null;
}

// ── Native audio engine (src-tauri/src/audio) ──────────────────────────────
export interface AudioDeviceInfo { id: string; name: string; isDefault: boolean }
export interface AudioDevices { host: string; inputs: AudioDeviceInfo[]; outputs: AudioDeviceInfo[] }
export interface EnergyVadConfig { minSpeechDb: number; marginDb: number; onsetHops: number; hangoverHops: number; maxSpeechHops: number }
export interface AudioEngineStartOptions {
  /** Device ids from audio_engine_devices; omitted / "default" = system default. */
  inputDevice?: string;
  outputDevice?: string;
  vad?: Partial<EnergyVadConfig>;
  /** Cut the assistant off when the user starts talking (default true). No AEC yet: use a headset. */
  bargeIn?: boolean;
}
export interface AudioStreamInfo { device: string; sampleRate: number; channels: number; format: string }
export interface AudioEngineStatus {
  running: boolean;
  input: AudioStreamInfo | null;
  output: AudioStreamInfo | null;
  captureQueued: number;
  captureOverruns: number;
  playbackQueued: number;
  playbackDiscarded: number;
  playbackUnderruns: number;
  bargeIns: number;
  bargeFlag: boolean;
  turnActive: boolean;
  playing: boolean;
  inSpeech: boolean;
  levelDb: number;
  lastError: string | null;
}
export type AudioEngineEvent =
  | { type: "speechStart"; bargedIn: boolean }
  | { type: "speechEnd"; durationMs: number }
  | { type: "bargeIn" }
  | { type: "streamError"; message: string };
