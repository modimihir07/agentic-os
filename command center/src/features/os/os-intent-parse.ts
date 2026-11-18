/**
 * Native OS-control intents — the pure half (no runtime imports beyond `gaba.ts`, so
 * it is unit-tested). `os-intents.ts` executes what this returns.
 *
 * These are local, reversible controls (Gabagool on/off/volume, stop audio, Spotify
 * playback, switch tab, swap model, compute mode, kill switch, status). They run
 * in-process before the planner, so a phrase like "turn off gabagool mode" can never
 * become a mutating plan for a gateway agent.
 *
 * Precedence for bare music words: a cue that is playing (volume) or active (stop) owns
 * them; otherwise they mean Spotify. Naming Gabagool / the theme, or Spotify, always wins.
 */
import type { RoleId } from "@/features/dispatcher/roles";
import { editDistance, norm } from "../cues/gaba.ts";

export type ComputeModeId = "local" | "hybrid" | "cloud";
export type WorkspaceId = "auto" | RoleId;

export type MediaAction = "play" | "pause" | "resume" | "next" | "previous" | "volume" | "now";
export type MediaKind = "track" | "artist" | "album" | "playlist";

export type OsIntent =
  | { kind: "gabagool-on" }
  /** `explicit` = the user named Gabagool; otherwise a bare "stop" while a cue is active. */
  | { kind: "gabagool-off"; explicit: boolean }
  /** Theme volume in steps of ±25 %. `explicit` = named Gabagool / the theme; otherwise a bare "louder" while a cue plays. */
  | { kind: "cue-volume"; steps: number; explicit: boolean }
  /** Spotify. `value` = absolute volume %, `delta` = relative volume change; `query`/`searchKind` for play. */
  | { kind: "media"; action: MediaAction; query?: string; searchKind?: MediaKind; value?: number; delta?: number }
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
  /** A cue is running right now: bare "louder" / "turn it down" change its theme, not Spotify. */
  cuePlaying?: boolean;
}

export const CUE_ACTIVE_MS = 10 * 60_000;

const LEAD = /^(?:(?:hey|ok|okay|yo|so|um|uh|alright|all right|right|and|now|then|just|please|can you|could you|would you|will you|go ahead and|i want you to|i need you to|let s)\s+)+/;
const TRAIL = /(?:\s+(?:please|now|for me|thanks|thank you|right now|ok|okay))+$/;

/** Normalised command text with wake word and politeness stripped. */
export function commandText(text: string, osName = "Tony"): string {
  const name = norm(osName) || "tony";
  const wake = new RegExp(`^(?:(?:hey|ok|okay|yo)\\s+)?(?:${escape(name)}|tony|jarvis)\\s+`);
  // "Turn it up, Tony." — the name addressed at the end (norm() already dropped the comma).
  const tailName = new RegExp(`(?:\\s+(?:${escape(name)}|tony|jarvis))+$`);
  let t = norm(text);
  for (let i = 0; i < 3; i++) {
    const before = t;
    t = t.replace(LEAD, "").replace(wake, "").replace(TRAIL, "").trim();
    // …but not when the name is the object: any workspace switch ("show tony", "open up
    // tony", "talk to tony") or a credit ("play something by tony").
    const untailed = t.replace(tailName, "").trim();
    if (untailed && !SWITCH_LEAD.test(t) && !/(?:^|\s)(?:to|with|by|from)$/.test(untailed)) t = untailed;
    if (t === before) break;
  }
  return t;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ── Gabagool ────────────────────────────────────────────────────────────────

const OFF_VERB = /\b(turn(?:ing)? (?:it )?off|turn of|switch(?:ing)? off|shut(?:ting)? (?:it )?(?:off|down)|exit(?:ing)?|disable|deactivate|stop(?:ping)?|end(?:ing)?|kill|quit|leave|cancel|no more|enough|out of|mute|pause|silence|get rid of|drop)\b/;
/** "turn the gabagool theme off": the verb and "off" need not be adjacent. */
const OFF_SPLIT = /\b(?:turn|switch|shut)(?: \w+){1,4} off\b|\b(?:shut|power)(?: \w+){1,4} down\b/;
/** "turn gabagool on", "switch the gabagool mode on". */
const ON_SPLIT = /\b(?:turn|switch)(?: \w+){1,4} on$/;
const ON_VERB = /\b(enter(?:ing)?|start(?:ing)?|turn(?:ing)? (?:it )?on|switch(?:ing)? on|activate|enable|begin|launch|go into|put on|engage|play)\b/;
/** Interjections before a bare stop ("hold on, stop", "no no stop", "dude stop"). */
const STOP_LEAD = /^(?:(?:hold on|hang on|wait|no|nope|ok|okay|dude|yo|bro|man|whoa|woah|hey)\s+)+/;
/** Bare stops that only mean "stop the cue" while one is active. */
const BARE_STOP = /^(?:stop(?: it| that| this)?(?: stop)*|make it stop|turn off|turn of|turn it off|switch off|switch it off|shut it off|shut it down|enough(?: already)?|that s enough|cut it|cut it out|kill it|off|be quiet|quiet|silence|shut up|pause(?: it| that)?|mute(?: it| that)?)$/;
const MUSIC_NOUN = "(?:music|theme|song|track|cue|soundtrack|audio|sound)";
const MUSIC_STOP = new RegExp(
  `^(?:(?:stop(?: playing)?|quit playing|kill|end|cut|turn off|turn of|shut off|switch off|mute|pause|silence)(?: the| that| this| my)? ${MUSIC_NOUN}|(?:turn|switch|shut)(?: the| that| this| my)? ${MUSIC_NOUN} off)$`,
);

/** Did the user say an ON verb ("enter", "start", "turn on", "play"…)? A running cue only restarts on one. */
export function hasOnVerb(text: string): boolean {
  return ON_VERB.test(norm(text));
}

/** Stops that name music or say pause/mute are Gabagool's only while its theme is actually
 * playing; otherwise they're Spotify's ("pause the music" after Gabagool ended). */
const PAUSE_MUTE = /^(?:pause|mute)\b/;

function gabagool(t: string, cueActive: boolean, cuePlaying: boolean): OsIntent | null {
  if (/\bgabagool\b/.test(t)) {
    if (OFF_VERB.test(t) || OFF_SPLIT.test(t) || /\bgabagool(?: mode)? off$/.test(t)) return { kind: "gabagool-off", explicit: true };
    if (ON_VERB.test(t) || ON_SPLIT.test(t) || /^(?:the )?gabagool(?: mode)?(?: on)?$/.test(t)) return { kind: "gabagool-on" };
    return null;
  }
  const s = t.replace(STOP_LEAD, "");
  if (!cueActive) return null;
  const musicStop = MUSIC_STOP.test(s) || (BARE_STOP.test(s) && PAUSE_MUTE.test(s));
  if (musicStop ? cuePlaying : BARE_STOP.test(s)) return { kind: "gabagool-off", explicit: false };
  return null;
}

// ── Volume (cue theme or Spotify) ───────────────────────────────────────────

/** Words allowed between "turn" and "up"/"down" (never "off", so "turn gabagool off, shut it down" stays a stop). */
const GAP = "(?:(?:it|that|this|the|my|gabagool|music|theme|song|track|volume|sound|audio|mode|spotify|a|bit|little|lot|tad|notch|way|all) ){0,4}";
// The bare "gabagool up/down" forms are anchored: "start gabagool up" is an ON command and
// "shut the gabagool down" an exit, never a volume nudge.
const UP = new RegExp(`^(?:the )?gabagool (?:music |theme |mode )?up\\b|\\b(?:louder|crank\\w*|boost|raise|increase|volume up|up the volume|more volume|(?:turn|pump|bring|jack|kick)\\w* ${GAP}up)\\b`);
const DOWN = new RegExp(`^(?:the )?gabagool (?:music |theme |mode )?down\\b|\\b(?:quieter|softer|lower|decrease|reduce|volume down|less volume|(?:turn|bring|tone)\\w* ${GAP}down)\\b`);
const BIG = /\b(?:crank\w*|a lot|lots|way (?:up|louder|more)|much louder)\b/;
/** Every word of a bare volume command ("make it a little louder") is one of these, so "lower the price" never matches. */
const VOLUME_WORDS = new Set(
  ("a an the it that this its s bit little tad touch notch notches couple lot lots more way much some so too just even slightly quite again " +
    "make turn turned crank cranked pump bring jack kick tone raise lower increase decrease reduce boost louder quieter softer up down " +
    "volume music song track sound audio tune tunes background of can you could would will get").split(" "),
);

/** Targets a bare volume command may also name ("turn the spotify volume up", "theme louder"). */
const TARGET_WORDS = new Set(["gabagool", "theme", "spotify", "mode", "on", "in", "my", "please"]);

function volume(t: string, opts: ParseOpts): OsIntent | null {
  const up = UP.test(t);
  const down = DOWN.test(t);
  if (up === down) return null;
  const steps = up ? (BIG.test(t) ? 2 : 1) : -1;
  // "theme"/"spotify" alone don't make a line a volume command ("tell the designer to lower the
  // contrast on the dark theme", "reduce spotify api calls"): those need an otherwise-bare
  // volume line. Naming Gabagool is enough ("I want to hear the gabagool music a little louder").
  const bare = t.split(" ").every((w) => VOLUME_WORDS.has(w) || TARGET_WORDS.has(w));
  if (/\bgabagool\b/.test(t) || (bare && /\btheme\b/.test(t))) return { kind: "cue-volume", steps, explicit: true };
  if (!bare) return null;
  if (/\bspotify\b/.test(t)) return { kind: "media", action: "volume", delta: 15 * steps };
  return opts.cuePlaying ? { kind: "cue-volume", steps, explicit: false } : { kind: "media", action: "volume", delta: 15 * steps };
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

// ── Spotify ─────────────────────────────────────────────────────────────────

const TENS: Record<string, number> = { ten: 10, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100, "a hundred": 100, "one hundred": 100 };
const NUM = "(\\d{1,3}|ten|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|a hundred|one hundred|hundred)";
const VOLUME_TO = [
  new RegExp(`^(?:(?:set|turn|put|change)(?: the)? )?(?:spotify s |spotify |music )?volume (?:on spotify )?(?:up |down )?(?:to |at )?${NUM}(?: percent)?(?: on spotify)?$`),
  new RegExp(`^(?:set|turn|put)(?: the)? spotify(?: volume)? (?:to|at) ${NUM}(?: percent)?$`),
];

const NOW = [
  /^what(?: s| is)? playing(?: on spotify)?(?: right now| now)?$/,
  /^what s on spotify$/,
  /^what (?:song|track|music)(?: is| s)? (?:this|that|playing|on)(?: on spotify)?(?: right now| now)?$/,
  /^what s this (?:song|track)$/,
  /^what am i listening to(?: right now| now)?$/,
  /^who (?:sings|is singing|s singing) (?:this|that)(?: song)?$/,
  /^(?:spotify )?now playing$/,
];
const PAUSE = [
  /^(?:pause|stop|mute)(?: the)? spotify(?: music)?$/,
  /^(?:pause|stop)(?: the)? (?:music|song|track) on spotify$/,
  /^pause(?: it| that| this)?$/,
  /^(?:turn|switch|shut) (?:off(?: the)? spotify|(?:the )?spotify off)$/,
  /^(?:stop|quit) playing(?: the| my)? (?:music|songs?|spotify)$/,
];
const RESUME = [
  /^(?:resume|unpause)(?: the)?(?: music| song| track| spotify| playback)?(?: on spotify)?$/,
  /^(?:continue|keep) (?:playing|the music|the song)$/,
  /^(?:start|turn)(?: the)? (?:music|spotify)(?: back)?(?: on)?$/,
];
const NEXT = [
  /^skip(?: (?:it|this|that|the))?(?: (?:song|track|one|tune))?(?: on spotify)?$/,
  /^next (?:song|track|tune)(?: on spotify)?$/,
  /^(?:play|go to|skip to|jump to)(?: the)? next (?:song|track|one|tune)(?: on spotify)?$/,
];
const PREVIOUS = [
  /^(?:previous|last|prior) (?:song|track|tune)(?: on spotify)?$/,
  /^(?:play|go to|skip to|go back to)(?: the)? (?:previous|last) (?:song|track|one|tune)(?: on spotify)?$/,
  /^(?:go |skip |jump )?back (?:a|one) (?:song|track)$/,
];
/** "play …" that isn't music: "play devil's advocate", "play a game", "play it again". */
const NOT_MUSIC = /^(?:it|that|this|along|back|again|a game|games?|the game|chess|cards|pretend|nice|dead|dumb|catch|fair|ball|tag|hard to get|(?:the )?devil s advocate|(?:a |the )?role|with|around|by ear|a trick|tricks)\b|\b(?:youtube|netflix|video|movie|film|twitch|game)\b/;
const PLAY_ON_SPOTIFY = /^(?:play|put on) (.+?) (?:on|from|in|with|using|via) spotify$|^spotify play (.+)$/;

/** Spotify search target for a spoken "play …" ("some jazz" → playlist, "songs by X" → artist). */
export function playTarget(q: string): { query: string; searchKind: MediaKind } {
  const clean = (s: string) => s.replace(/ by /g, " ").trim();
  let m: RegExpExecArray | null;
  if ((m = /^(?:some )?(?:songs|music|something|stuff|tracks|anything) (?:by|from) (.+)$/.exec(q))) return { query: m[1], searchKind: "artist" };
  if ((m = /^(?:the )?album (?:called |named )?(.+)$/.exec(q) ?? /^(?:the )?(.+) album$/.exec(q))) return { query: clean(m[1]), searchKind: "album" };
  if ((m = /^(?:the |my )?playlist (?:called |named )?(.+)$/.exec(q) ?? /^(?:the |my )?(.+) playlist$/.exec(q))) return { query: m[1], searchKind: "playlist" };
  if ((m = /^some (.+)$/.exec(q))) return { query: m[1], searchKind: "playlist" };
  m = /^(?:the )?(?:song|track) (?:called |named )?(.+)$/.exec(q);
  return { query: clean(m ? m[1] : q), searchKind: "track" };
}

/** "play X on spotify", or a short "play X" that isn't a game, a role or a video. */
function play(t: string): OsIntent | null {
  let q: string;
  const named = PLAY_ON_SPOTIFY.exec(t);
  if (named) q = named[1] ?? named[2];
  else {
    const m = /^play (.+)$/.exec(t);
    if (!m || t.split(" ").length > 8 || NOT_MUSIC.test(m[1])) return null;
    q = m[1];
  }
  if (/^(?:the |some |my )?(?:music|spotify|songs?|tunes?)(?: again| back)?$/.test(q)) return { kind: "media", action: "resume" };
  return { kind: "media", action: "play", ...playTarget(q) };
}

function media(t: string, opts: ParseOpts): OsIntent | null {
  if (/\bgabagool\b/.test(t)) return null;
  for (const re of VOLUME_TO) {
    const m = re.exec(t);
    if (!m) continue;
    // A bare "volume 30" belongs to a playing cue, which has no absolute volume: leave it to Tony.
    if (opts.cuePlaying && !/\b(?:spotify|music)\b/.test(t)) return null;
    return { kind: "media", action: "volume", value: Math.min(100, TENS[m[1]] ?? Number(m[1])) };
  }
  if (NOW.some((re) => re.test(t))) return { kind: "media", action: "now" };
  const s = t.replace(STOP_LEAD, "");
  if (PAUSE.some((re) => re.test(s)) || MUSIC_STOP.test(s)) return { kind: "media", action: "pause" };
  if (RESUME.some((re) => re.test(t))) return { kind: "media", action: "resume" };
  if (NEXT.some((re) => re.test(t))) return { kind: "media", action: "next" };
  if (PREVIOUS.some((re) => re.test(t))) return { kind: "media", action: "previous" };
  return play(t);
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
  if (!t) return null;
  // Long rambles only count as volume ("I want to hear the gabagool music a little louder").
  if (t.split(" ").length > 12) return volume(t, opts);

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

  return volume(t, opts) ?? gabagool(t, !!opts.cueActive, !!opts.cuePlaying) ?? workspace(t, osName) ?? media(t, opts);
}

/**
 * Never a mutating plan for a gateway agent: true for anything the intent layer owns,
 * including bare stops ("turn off", "stop it") even when no cue is playing, and Spotify
 * controls ("pause the music", "set the volume to 30").
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
