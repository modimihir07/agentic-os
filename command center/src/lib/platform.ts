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
  os_secret_delete: { args: { name: OsSecret }; result: void };
  privacy_last_payload: { args: undefined; result: RedactionRecord | null };
  privacy_preview: { args: { text: string }; result: { redacted: string; replacements: Replacement[] } };
  droplet_test: { args: undefined; result: EndpointProbe[] };
  network_audit: { args: undefined; result: ListenFinding[] };
  gateway_token_rotate: { args: undefined; result: string };
  anythingllm_workspaces: { args: undefined; result: { slug: string; name: string; threads: number }[] };
  os_turn: { args: { req: OsTurnRequest }; result: OsTurnResult };
  overseer_ask: { args: { req: { question: string; transcript: ChatMessage[]; context: string; engine?: string } }; result: { answer: string; engine: string; latencyMs: number; redacted: boolean } };
  mcp_list_tools: { args: { refresh?: boolean }; result: ServerTools[] };
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
}

/**
 * Send raw bytes to a Rust command that takes `tauri::ipc::Request`
 * (WAV → stt_transcribe, a voice file → tts_voice_upload).
 */
export async function nativeRaw<T>(cmdName: "stt_transcribe" | "tts_voice_upload", body: Uint8Array, headers?: Record<string, string>): Promise<T> {
  if (!isTauri()) throw new Error(`native command "${cmdName}" is desktop-only`);
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmdName, body, headers ? { headers } : undefined);
}

/** Subscribe to a Rust → webview event. Returns an unsubscribe function. No-op on the PWA. */
export async function onNativeEvent<P = unknown>(event: "voice-toggle" | "memory-progress" | "pipeline-step" | "pipeline-failed" | "gpu-slot" | "droplet-status" | "tony-token" | "tts-fallback" | "spotify-auth", handler: (payload: P) => void): Promise<() => void> {
  if (!isTauri()) return () => undefined;
  const { listen } = await import("@tauri-apps/api/event");
  return listen<P>(event, (e) => handler(e.payload));
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

export type ProviderPatch = { id: string } & Partial<Pick<ProviderInfo, "label" | "baseUrl" | "model" | "voice" | "language" | "engine" | "modelsDir" | "voicesDir">>;
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
export type OsSecret = "anthropic" | "gemini" | "brave" | "twelvedata" | "vault" | "gateway-token" | "anythingllm-remote" | "gmail-script-id" | "gmail-script-key" | "spotify-refresh";
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
}

export interface AllmSyncReport {
  added: string[];
  kept: string[];
  skipped: string[];
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
}

export type SpotifyAction = "play" | "pause" | "resume" | "next" | "previous" | "volume" | "shuffle";
export interface SpotifyStatus {
  configured: boolean;
  connected: boolean;
  account: string | null;
  /** A token is stored but Spotify refuses it (e.g. the app owner needs Premium). */
  problem: string | null;
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
