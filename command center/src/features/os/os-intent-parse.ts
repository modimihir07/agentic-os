/**
 * Native OS-control intents — the pure half (no runtime imports beyond `gaba.ts`, so
 * it is unit-tested with `node --test`). `os-intents.ts` executes what this returns.
 *
 * These are local, reversible controls (Gabagool on/off, stop audio, switch tab,
 * swap model, compute mode, kill switch, status). They run in-process before the
 * planner, so a phrase like "turn off gabagool mode" can never become a mutating
 * plan for a gateway agent.
 */
import type { RoleId } from "@/features/dispatcher/roles";
import { editDistance, norm } from "../cues/gaba.ts";

export type ComputeModeId = "local" | "hybrid" | "cloud";
export type WorkspaceId = "auto" | RoleId;

export type OsIntent =
  | { kind: "gabagool-on" }
  /** `explicit` = the user named Gabagool; otherwise a bare "stop" while a cue is active. */
  | { kind: "gabagool-off"; explicit: boolean }
  | { kind: "workspace"; thread: WorkspaceId }
  | { kind: "model"; query: string }
  | { kind: "compute"; mode: ComputeModeId }
  | { kind: "kill-switch"; on: boolean }
  | { kind: "status" };

export interface ParseOpts {
  /** The OS name from Settings ("Tony"); stripped as a wake word and accepted as Tony's tab. */
  osName?: string;
  /** A cue is running or fired in the last 10 minutes: bare "stop" / "turn off" stop it. */
  cueActive?: boolean;
}

export const CUE_ACTIVE_MS = 10 * 60_000;

const LEAD = /^(?:(?:hey|ok|okay|yo|so|um|uh|alright|all right|right|and|now|then|just|please|can you|could you|would you|will you|go ahead and|i want you to|i need you to|let s)\s+)+/;
const TRAIL = /(?:\s+(?:please|now|for me|thanks|thank you|right now|ok|okay))+$/;

/** Normalised command text with wake word and politeness stripped. */
export function commandText(text: string, osName = "Tony"): string {
  const name = norm(osName) || "tony";
  const wake = new RegExp(`^(?:(?:hey|ok|okay|yo)\\s+)?(?:${escape(name)}|tony|jarvis)\\s+`);
  let t = norm(text);
  for (let i = 0; i < 3; i++) {
    const before = t;
    t = t.replace(LEAD, "").replace(wake, "").replace(TRAIL, "").trim();
    if (t === before) break;
  }
  return t;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ── Gabagool ────────────────────────────────────────────────────────────────

const OFF_VERB = /\b(turn(?:ing)? (?:it )?off|switch(?:ing)? off|shut(?:ting)? (?:it )?(?:off|down)|exit(?:ing)?|disable|deactivate|stop(?:ping)?|end(?:ing)?|kill|quit|leave|cancel|no more|enough|out of)\b/;
const ON_VERB = /\b(enter(?:ing)?|start(?:ing)?|turn(?:ing)? (?:it )?on|switch(?:ing)? on|activate|enable|begin|launch|go into|put on|engage)\b/;
/** Bare stops that only mean "stop the cue" while one is active. */
const BARE_STOP = /^(?:turn off|turn it off|switch off|switch it off|shut it off|shut it down|stop|stop it|stop that|enough|that s enough|cut it|cut it out|kill it|off|be quiet|quiet|silence|shut up)$/;
const MUSIC_STOP = /^(?:stop|kill|end|cut|turn off|shut off|mute|pause)(?: the| that)? (?:music|theme|song|track|cue|soundtrack)$/;

function gabagool(t: string, cueActive: boolean): OsIntent | null {
  if (/\bgabagool\b/.test(t)) {
    if (OFF_VERB.test(t) || /\bgabagool(?: mode)? off$/.test(t)) return { kind: "gabagool-off", explicit: true };
    if (ON_VERB.test(t) || /^(?:the )?gabagool(?: mode)?(?: on)?$/.test(t)) return { kind: "gabagool-on" };
    return null;
  }
  if (cueActive && (BARE_STOP.test(t) || MUSIC_STOP.test(t))) return { kind: "gabagool-off", explicit: false };
  return null;
}

// ── Workspace / agent tab ───────────────────────────────────────────────────

/** Spoken names → thread. `suffix` names only count with "tab/desk/agent" after them. */
const AGENT_NAMES: Record<WorkspaceId, { bare: string[]; suffix: string[] }> = {
  auto: { bare: ["auto", "auto route", "autoroute", "auto routing", "auto router"], suffix: ["dispatcher"] },
  general: { bare: ["tony", "general"], suffix: ["main", "os"] },
  booking: { bare: ["booking", "bookings", "booking desk", "booking agent", "the booking desk"], suffix: ["book"] },
  prompter: { bare: ["prompter", "prompt builder", "the prompter"], suffix: ["prompt"] },
  coder: { bare: ["coder", "coding agent", "the coder", "developer"], suffix: ["code", "coding", "dev"] },
  designer: { bare: ["designer", "design agent", "the designer"], suffix: ["design", "ui", "ux"] },
  librarian: { bare: ["librarian", "the librarian"], suffix: ["library", "research"] },
  ops: { bare: ["ops", "operations", "ops agent"], suffix: ["op"] },
};
const SWITCH_LEAD = /^(?:switch(?: over)?|change|swap|flip|jump|move|head|hop)(?: me)? (?:to|over to) |^(?:open(?: up)?|go(?: over)? to|show(?: me)?|take me to|bring up|pull up|talk to|let me talk to|i want to talk to)\s/;
const SUFFIX = /\s(?:tab|desk|agent|workspace|thread|chat|channel)$/;

function workspace(t: string, osName: string): OsIntent | null {
  const m = SWITCH_LEAD.exec(t);
  if (!m) return null;
  let rest = t.slice(m[0].length).replace(/^(?:the|my|our)\s+/, "").trim();
  const hadSuffix = SUFFIX.test(rest);
  rest = rest.replace(SUFFIX, "").replace(/^(?:the|my|our)\s+/, "").trim();
  const name = norm(osName);
  if (name && rest === name) return { kind: "workspace", thread: "general" };
  for (const [id, n] of Object.entries(AGENT_NAMES) as [WorkspaceId, { bare: string[]; suffix: string[] }][]) {
    if (n.bare.includes(rest) || (hadSuffix && n.suffix.includes(rest))) return { kind: "workspace", thread: id };
  }
  // "talk to …" with anything else is a delegation request, not a tab switch.
  return null;
}

// ── Model / compute / kill switch / status ──────────────────────────────────

const MODEL = [
  /^(?:switch|change|swap|set|move)(?: the| your| tony s| my)? (?:model|brain|llm|local model)(?: over)? to (.+)$/,
  /^(?:use|load|run(?: on)?)(?: the)? (?:model|llm) (.+)$/,
  /^(?:switch|swap|change|move)(?: over)? to(?: the)? (?:model|llm) (.+)$/,
];

const COMPUTE = [
  /^(?:go|switch|change|set|flip|move|put(?: it| us| everything)?|run)(?: (?:it|us|everything|compute|compute mode|the compute mode|mode))?(?: to| into| in)? (local|hybrid|cloud)(?: mode| compute| only)?$/,
  /^(?:use )?(local|hybrid|cloud) (?:mode|compute)(?: on)?$/,
  /^compute(?: mode)?(?: to)? (local|hybrid|cloud)$/,
];

const KILL_ON_OFF = [
  /^(?:turn|switch|flip|set)(?: (on|off))?(?: the)? kill ?switch(?: (on|off))?$/,
  /^(?:the )?kill ?switch (on|off)$/,
];
const KILL_ON = /^(?:enable|activate|engage|arm|hit|pull|throw)(?: the)? kill ?switch$/;
const KILL_OFF = /^(?:disable|deactivate|disengage|disarm|release|reset)(?: the)? kill ?switch$/;

const STATUS = [
  /^(?:what s |what is |give me |run |do |show(?: me)? )?(?:the |a |my )?(?:system|systems|os) (?:status|check|health|report)(?: report| check| update)?$/,
  /^status (?:report|check|update)$/,
  /^how are (?:the |my |all )?(?:the )?systems(?: doing| looking)?$/,
];

/**
 * Parse an OS-control command. Returns null for anything else (it then goes on to
 * idea capture, local intents and the planner).
 */
export function parseOsIntent(text: string, opts: ParseOpts = {}): OsIntent | null {
  const osName = opts.osName || "Tony";
  const t = commandText(text, osName);
  if (!t || t.split(" ").length > 12) return null;

  for (const re of KILL_ON_OFF) {
    const m = re.exec(t);
    if (m) {
      const v = m[1] ?? m[2];
      if (v) return { kind: "kill-switch", on: v === "on" };
    }
  }
  if (KILL_ON.test(t)) return { kind: "kill-switch", on: true };
  if (KILL_OFF.test(t)) return { kind: "kill-switch", on: false };

  for (const re of COMPUTE) {
    const m = re.exec(t);
    if (m) return { kind: "compute", mode: m[1] as ComputeModeId };
  }
  for (const re of MODEL) {
    const m = re.exec(t);
    if (m) {
      const query = m[1].replace(/\s+(?:model|please)$/, "").trim();
      if (query) return { kind: "model", query };
    }
  }
  if (STATUS.some((re) => re.test(t))) return { kind: "status" };

  const g = gabagool(t, !!opts.cueActive);
  if (g) return g;
  return workspace(t, osName);
}

/**
 * Never a mutating plan for a gateway agent: true for anything the intent layer owns,
 * including bare stops ("turn off", "stop it") even when no cue is playing.
 */
export function isOsControlPhrase(text: string, osName?: string): boolean {
  return parseOsIntent(text, { osName, cueActive: true }) !== null;
}

// ── Model name resolution ───────────────────────────────────────────────────

const NUMBER_WORDS: Record<string, string> = {
  zero: "0", oh: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10",
  eleven: "11", twelve: "12", thirteen: "13", fourteen: "14", fifteen: "15", sixteen: "16", twenty: "20", thirty: "30", seventy: "70",
};
/** Whisper spellings of common model families. */
const MODEL_ALIASES: Record<string, string> = {
  quen: "qwen", kwen: "qwen", queen: "qwen", quinn: "qwen", gwen: "qwen", qwin: "qwen",
  lama: "llama", llamma: "llama", jemma: "gemma", mistrel: "mistral", mistrall: "mistral", fi: "phi", fie: "phi",
};
const MODEL_STOP = new Set(["the", "a", "an", "model", "llm", "version", "point", "dot", "latest", "please"]);

function modelWords(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter((w) => w && !MODEL_STOP.has(w))
    .map((w) => NUMBER_WORDS[w] ?? MODEL_ALIASES[w] ?? w);
}
const key = (s: string) => modelWords(s).join("");

/**
 * Best match for a spoken model name among model ids ("qwen three eight b" →
 * "qwen/qwen3-8b"). Returns null when nothing is close enough.
 */
export function resolveModel(query: string, models: string[]): string | null {
  const q = key(query);
  const qWords = modelWords(query);
  if (!q) return null;
  let best: { id: string; score: number } | null = null;
  for (const id of models) {
    const full = key(id);
    const base = key(id.split("/").pop() ?? id);
    if (!full) continue;
    let score = 0;
    if (base === q || full === q) score = 1000;
    else if (base.startsWith(q)) score = 600 - (base.length - q.length);
    else if (base.includes(q) || full.includes(q)) score = 500 - (full.length - q.length);
    else {
      const covered = qWords.filter((w) => full.includes(w)).length;
      if (covered === qWords.length) score = 300 - full.length;
      else if (covered / qWords.length >= 0.5 && qWords.some((w) => w.length >= 3 && full.includes(w))) score = 100 * (covered / qWords.length);
      else {
        const sim = 1 - editDistance(q, base) / Math.max(q.length, base.length);
        if (sim >= 0.7) score = 100 * sim;
      }
    }
    if (score > 0 && (!best || score > best.score || (score === best.score && id.length < best.id.length))) best = { id, score };
  }
  return best?.id ?? null;
}
