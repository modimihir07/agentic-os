import { cmd, isTauri, type ChatMessage, type WorkflowInfo } from "@/lib/platform";
import { SUB_AGENTS, type AgentRole } from "@/features/dispatcher/agents";
import { DEFAULT_ROUTING_CONFIG, resolve as resolveRoute } from "@/features/dispatcher/router";
import { extractJson } from "@/features/orchestrator/extract-json";
import { parseDraftEmail, type DraftParse } from "@/features/orchestrator/draft-email";
import { isOsControlPhrase } from "@/features/os/os-intent-parse";
import { useOs } from "@/features/os/os-store";
import { useSettings } from "@/stores/settings";
import type { ThreadId } from "@/features/voice/voice-store";

/**
 * Master Dispatcher: speech → structured ActionPlan.
 *
 *   1. Heuristic plan (instant, offline) — always computed, used as the floor.
 *   2. Model plan (desktop): the local model returns strict JSON. It may ADD
 *      detail but can never downgrade `mutating` to false (OR with heuristic).
 *   3. Verifier (desktop, mutating only): a separate local model (LM Studio, zero cost)
 *      checks the plan against the user's exact words and flags invented
 *      details. A flagged or unverified plan still needs the human's yes.
 *
 * Nothing in this file executes anything.
 */

export type PlanTarget =
  | { kind: "agent" }
  | { kind: "n8n"; workflow: string }
  /** A Permission-Bridge-gated native action (n8n run/toggle, Drive sync…). */
  | { kind: "bridge"; action: string; scopes: string[] }
  /** A native tool behind its own approved-only Rust command (execute.ts), e.g. `gmail.create_draft`. */
  | { kind: "tool"; tool: string; args: Record<string, unknown> };

export interface Verification {
  status: "verified" | "flagged" | "unverified" | "skipped";
  notes: string[];
  by?: string;
}

export interface ActionPlan {
  id: string;
  utterance: string;
  role: AgentRole;
  intent: string;
  summary: string;
  readBack: string;
  mutating: boolean;
  target: PlanTarget;
  payload: Record<string, unknown>;
  missing: string[];
  verification: Verification;
  planner: "model" | "heuristic";
  plannerNote?: string;
  /** Dispatcher tab this plan came from (its answer lands there). */
  thread?: ThreadId;
  /** The user picked the agent's tab — talk to it directly. */
  explicitRole?: boolean;
  /** How `role` was resolved ("Named" | "Domain" | "Tab" | "Default"). A Named
   * route is the user naming an agent directly — the model planner may never
   * override it, even if its own keyword read looks stronger. */
  routeKind?: string;
  /** In-memory only: for bridge plans, what to run once approved / when cancelled. */
  run?: () => Promise<{ text: string; meta: string }>;
  onCancel?: () => void;
}

// ── Heuristics ───────────────────────────────────────────────────────────────

/** Verbs that change the world. Over-matching is fine: it only adds a confirmation. */
const MUTATING =
  /\b(cancel|delete|remove|erase|wipe|send|reply|forward|post|publish|tweet|share|upload|book|reserve|rsvp|buy|purchase|order|pay|transfer|refund|schedule|reschedule|move|create|add|invite|update|change|edit|rename|set|turn (on|off)|deploy|push|merge|commit|restart|reboot|stop|kill|shut ?down|start|launch|run|trigger|execute|unsubscribe|archive|install|uninstall|approve|accept|decline|sign)\b/i;

/** A plain question ("when is my dinner?") isn't an action — unless it chains one ("…and cancel it"). */
const QUESTION = /^(what|when|where|who|whom|whose|why|how|which|is|are|was|were|do|does|did|has|have|any)\b/i;
const CHAINED = /\b(and|then|also|after that|plus)\b|[,;]/i;

/** Nouns that are also verbs ("email Sam…") only count in command position. */
const COMMAND_VERB = /(^|\b(and|then|also)\s+)(e-?mail|text|message|dm|ping|call)\b/i;

/** Playback controls ("change the song", "start my workout playlist") are Spotify's job (intent
 * layer / Tony's spotify_plan), never a gateway agent's — unless they edit the library. */
const PLAYBACK = /\b(play(ing)?|pause|resume|skip|next|previous|restart|start|change|switch|put on|stop|turn)\b.*\b(spotify|music|songs?|tracks?|playlists?|albums?|tunes?)\b/i;
const LIBRARY_EDIT = /\b(add|save|like|remove|delete|create|follow|unfollow|share|send|post|rename)\b/i;
const isPlayback = (s: string) => PLAYBACK.test(s) && !LIBRARY_EDIT.test(s);

function looksMutating(utterance: string): boolean {
  const s = utterance.trim().replace(filler(), "");
  if (!MUTATING.test(s) && !COMMAND_VERB.test(s)) return false;
  return !(QUESTION.test(s) && !CHAINED.test(s));
}

const NAME_ALT = () => {
  const n = (useSettings.getState().osName || "Tony").toLowerCase().replace(/[^a-z0-9 ]/g, "");
  return `${n}|jarvis`;
};
let fillerCache: { key: string; re: RegExp } | null = null;
/** "hey tony, please …" → "…" (the OS name follows Settings). */
const filler = () => {
  const key = NAME_ALT();
  if (fillerCache?.key !== key) fillerCache = { key, re: new RegExp(`^(hey|ok(ay)?|yo)?[\\s,]*(${key})?[\\s,]*(please|can you|could you|would you|i need you to|i want you to|go ahead and)?[\\s,]*`, "i") };
  return fillerCache.re;
};
/** Drop a leading wake phrase ("Hey Tony,") but keep the request intact. */
export const stripWake = (s: string) => s.replace(new RegExp(`^(hey|ok(ay)?|yo)?[\\s,]*(${NAME_ALT()})\\b[\\s,:.!-]*`, "i"), "").trim() || s;

/** "cancel my dinner with Sam" → "cancel your dinner with Sam" (for the read-back). */
export function toSecondPerson(s: string): string {
  return s
    .replace(/\bI'm\b/g, "you're")
    .replace(/\bI've\b/g, "you've")
    .replace(/\bI\b/g, "you")
    .replace(/\bmy\b/gi, "your")
    .replace(/\bmine\b/gi, "yours")
    .replace(/\bme\b/gi, "you")
    .replace(/\bmyself\b/gi, "yourself");
}

function cleanIntent(utterance: string): string {
  const s = utterance.trim().replace(filler(), "").replace(/[\s,]*(please|thanks|thank you)[.!?]*$/i, "").replace(/[.!?]+$/, "");
  return toSecondPerson(s.charAt(0).toLowerCase() + s.slice(1));
}

function readBackFor(p: Pick<ActionPlan, "role" | "intent" | "target" | "missing" | "verification">): string {
  let s: string;
  if (p.target.kind === "tool" && p.target.tool === "gmail.create_draft") {
    const a = p.target.args;
    s = `Got it — saving a Gmail draft to ${a.to}, subject "${a.subject}". It won't be sent.`;
  } else {
    const who = p.target.kind === "n8n" ? `running the ${p.target.workflow} workflow` : `instructing ${SUB_AGENTS[p.role].label}`;
    s = `Got it — ${who} to ${p.intent}.`;
  }
  if (p.missing.length) s += ` I don't have the ${p.missing.slice(0, 2).join(" or ")}.`;
  if (p.verification.status === "flagged") s += " Heads up: the verifier flagged a possible mismatch.";
  return `${s} Proceed?`;
}

/** Deterministic routing fallback when the caller didn't already resolve a role
 * (every voice-controller.ts call site does; this only covers direct callers
 * like gate.ts/Reminders.tsx that always pass their own role, plus belt-and-suspenders). */
function fallbackRole(utterance: string): AgentRole {
  const routingCfg = useOs.getState().cfg?.routing ?? DEFAULT_ROUTING_CONFIG;
  const route = resolveRoute(utterance, routingCfg);
  return (route.role as AgentRole) ?? "general";
}

export function heuristicPlan(utterance: string, role?: AgentRole): ActionPlan {
  const r = role ?? fallbackRole(utterance);
  const intent = cleanIntent(utterance);
  // "…saying I'm running late, Tony." — the name addressed at the end isn't part of the email.
  const draftText = utterance.trim().replace(filler(), "").replace(new RegExp(`\\s*,\\s*(?:${NAME_ALT()})[\\s.!?]*$`, "i"), "");
  const draft = parseDraftEmail(draftText);
  // An address-less draft routed to another desk ("draft an email to my agent about the
  // self-tape" → Booking Desk, one of its routing domains) is that desk's job, not a
  // "who should it go to?" prompt. A reply ("draft a reply to my last email") is about the
  // user's own inbox, so it still asks for the address.
  const deskDraft = draft?.kind === "ask" && r !== "general" && !/\breply\b/i.test(utterance);
  if (draft && !deskDraft) return draftPlan(utterance, r, intent, draft);
  // "turn off gabagool mode" matches MUTATING's `turn (on|off)`, but the OS-control
  // intent layer (voice-controller.ts) owns these phrases before the plan is ever
  // built — they must never become a mutating plan for a gateway agent.
  const mutating = looksMutating(utterance) && !isOsControlPhrase(utterance, useSettings.getState().osName) && !isPlayback(utterance);
  const plan: ActionPlan = {
    id: crypto.randomUUID(),
    utterance,
    role: r,
    intent,
    summary: `${SUB_AGENTS[r].label}: ${intent.charAt(0).toUpperCase()}${intent.slice(1)}`,
    readBack: "",
    mutating,
    target: { kind: "agent" },
    payload: {},
    missing: [],
    verification: { status: "skipped", notes: [] },
    planner: "heuristic",
  };
  plan.readBack = readBackFor(plan);
  return plan;
}

/** A Gmail draft: a mutating plan bound to `gmail.create_draft`, or a read-only follow-up question. */
function draftPlan(utterance: string, role: AgentRole, intent: string, d: DraftParse): ActionPlan {
  const plan: ActionPlan = {
    id: crypto.randomUUID(),
    utterance,
    role,
    intent,
    summary: "",
    readBack: "",
    mutating: false,
    target: { kind: "agent" },
    payload: {},
    missing: [],
    verification: { status: "skipped", notes: [] },
    planner: "heuristic",
    plannerNote: "Gmail draft binding",
  };
  if (d.kind === "ask" || !isTauri()) {
    const text = d.kind === "ask" ? d.reply : "Gmail drafts are saved by the desktop app — ask me there.";
    plan.summary = "Gmail draft";
    plan.run = async () => ({ text, meta: "gmail · draft" });
    return plan;
  }
  const args = { to: d.to, subject: d.subject, body: d.body };
  plan.mutating = true;
  plan.target = { kind: "tool", tool: "gmail.create_draft", args };
  plan.payload = args;
  plan.summary = `Save a Gmail draft to ${d.to}: "${d.subject}"`;
  plan.readBack = readBackFor(plan);
  return plan;
}

// ── Model planner ────────────────────────────────────────────────────────────

let workflowsCache: { at: number; list: WorkflowInfo[] } | null = null;
async function n8nWorkflows(): Promise<WorkflowInfo[]> {
  if (!isTauri()) return [];
  if (!workflowsCache || Date.now() - workflowsCache.at > 60_000) {
    workflowsCache = { at: Date.now(), list: await cmd("n8n_workflows").catch(() => [] as WorkflowInfo[]) };
  }
  return workflowsCache.list;
}

const ROLE_PROMPT_ORDER: AgentRole[] = ["general", "booking", "prompter", "coder", "designer", "librarian", "ops"];

function plannerPrompt(workflows: WorkflowInfo[]): string {
  const wf = workflows.map((w) => `"${w.name}"${w.description ? ` (${w.description})` : ""}`).join(", ");
  const roles = ROLE_PROMPT_ORDER.map((r) => `"${r}" (${SUB_AGENTS[r].label})`).join(", ");
  return [
    `You are the Master Dispatcher of ${useSettings.getState().osName || "Tony"}. Convert the user's request into ONE JSON object and nothing else.`,
    "If the request names an agent directly (\"tell my booking agent to…\", \"ask the coder…\"), that agent wins — never pick a different role, even if its keywords look stronger.",
    "Schema:",
    `{"role": one of ${roles},`,
    ` "intent": imperative verb phrase in second person, max 12 words (e.g. "cancel your 7pm dinner with Sam"),`,
    ` "summary": one line for a confirmation card,`,
    ` "mutating": boolean,`,
    workflows.length
      ? ` "target": {"kind":"agent"} or {"kind":"n8n","workflow": one of ${wf}},`
      : ` "target": {"kind":"agent"},`,
    ` "payload": object of structured fields taken from the request (event, date, time, recipients, subject, body, amount…),`,
    ` "missing": array of required details the user did not give}`,
    "mutating = true if the action would change, send, book, buy, pay, delete, cancel, schedule, post, deploy, start/stop anything, or otherwise affect anything outside this conversation. When unsure: true.",
    "NEVER invent names, dates, times, amounts or recipients. Unknown values go in \"missing\", not in payload.",
  ].join("\n");
}

const str = (v: unknown, max = 200) => (typeof v === "string" ? v.trim().slice(0, max) : "");

async function modelPlan(base: ActionPlan, history: ChatMessage[]): Promise<ActionPlan> {
  const workflows = await n8nWorkflows();
  const res = await cmd("dispatch_chat", {
    req: {
      messages: [
        { role: "system", content: plannerPrompt(workflows) },
        ...history.slice(-4),
        { role: "user", content: base.utterance },
      ],
      priority: "interactive",
      maxSecs: 15,
    },
  });
  const j = extractJson(res.content);
  if (!j) throw new Error("planner returned no JSON");

  // A route the user named directly always wins — the model never overrides it.
  const role = base.routeKind !== "Named" && (Object.keys(SUB_AGENTS) as AgentRole[]).includes(j.role as AgentRole) ? (j.role as AgentRole) : base.role;
  const t = j.target as { kind?: string; workflow?: string } | undefined;
  const wfInfo = base.target.kind === "agent" && t?.kind === "n8n" ? workflows.find((w) => w.name === t.workflow) : undefined;
  // Only an agent target may be re-targeted; a tool/bridge binding is never downgraded.
  const target: PlanTarget = base.target.kind !== "agent" ? base.target : wfInfo ? { kind: "n8n", workflow: wfInfo.name } : { kind: "agent" };
  const plan: ActionPlan = {
    ...base,
    role,
    intent: toSecondPerson(str(j.intent, 120)) || base.intent,
    summary: str(j.summary) || base.summary,
    // Safety: the model can escalate to mutating, never de-escalate.
    mutating: base.mutating || j.mutating === true || !!wfInfo?.mutating,
    target,
    payload: base.target.kind === "tool" ? base.payload : j.payload && typeof j.payload === "object" && !Array.isArray(j.payload) ? (j.payload as Record<string, unknown>) : {},
    missing: Array.isArray(j.missing) ? j.missing.map((m) => str(m, 40)).filter(Boolean).slice(0, 5) : [],
    planner: "model",
    plannerNote: `${res.providerId} · ${res.latencyMs}ms`,
  };
  plan.readBack = readBackFor(plan);
  return plan;
}

// ── Verifier ─────────────────────────────────────────────────────────────────

const VERIFIER_PROMPT = [
  "You verify an AI dispatcher's plan against the user's exact words.",
  'Reply ONLY with JSON: {"consistent": boolean, "issues": [string]}.',
  "Flag: details not present in the request (invented names, dates, times, amounts, recipients), the wrong action, the wrong target, or a world-changing action marked non-mutating.",
  "Do not judge whether the action is wise. Be terse.",
].join("\n");

async function verify(plan: ActionPlan): Promise<Verification> {
  try {
    const res = await cmd("dispatch_chat", {
      req: {
        messages: [
          { role: "system", content: VERIFIER_PROMPT },
          {
            role: "user",
            content: `Request: "${plan.utterance}"\nPlan: ${JSON.stringify({
              role: plan.role, intent: plan.intent, summary: plan.summary, mutating: plan.mutating, target: plan.target, payload: plan.payload,
            })}`,
          },
        ],
        priority: "interactive",
        provider: "verifier",
        maxSecs: 12,
      },
    });
    const j = extractJson(res.content);
    if (!j || typeof j.consistent !== "boolean") return { status: "unverified", notes: ["Verifier gave no verdict"], by: res.providerId };
    const issues = Array.isArray(j.issues) ? j.issues.map((i) => str(i, 160)).filter(Boolean).slice(0, 4) : [];
    return j.consistent && !issues.length ? { status: "verified", notes: [], by: res.providerId } : { status: "flagged", notes: issues.length ? issues : ["Inconsistent with request"], by: res.providerId };
  } catch (e) {
    return { status: "unverified", notes: [e instanceof Error ? e.message : String(e)] };
  }
}

// ── Entry point ─────────────────────────────────────────────────────────────

export async function planIntent(utterance: string, opts: { role?: AgentRole; history?: ChatMessage[] } = {}): Promise<ActionPlan> {
  let plan = heuristicPlan(utterance, opts.role);
  if (isTauri()) {
    // Plain questions skip the model planner (one fewer model call per turn): the OS
    // core routes them anyway. Anything that could change the world still gets the
    // full model plan + verifier. A tool binding's fields come straight from the
    // words, so it skips the planner (the verifier still checks it).
    if (plan.mutating && plan.target.kind !== "tool") {
      try {
        plan = await modelPlan(plan, opts.history ?? []);
      } catch (e) {
        plan.plannerNote = `model planner unavailable (${e instanceof Error ? e.message : e}) — heuristic`;
      }
    } else if (!plan.mutating) {
      plan.plannerNote ??= "question — heuristic routing (no planner call)";
    }
    if (plan.mutating) {
      plan.verification = await verify(plan);
      plan.readBack = readBackFor(plan);
    }
  } else if (plan.mutating) {
    plan.verification = { status: "unverified", notes: ["Mobile: the local verifier runs on the desktop"] };
  }
  return plan;
}

// ── Confirmation replies ────────────────────────────────────────────────────

const YES = /^(yes|yeah|yep|yup|ok(ay)?|sure|do it|go( ahead)?|proceed|confirm(ed)?|approved?|affirmative|send it|make it so|execute)\b/i;
const NO = /^(no|nope|nah|cancel|stop|abort|don'?t|negative|wait|hold (on|up)|never ?mind|scratch that)\b/i;

/** Strict on purpose: "yes, but…" or anything hedged is NOT a yes. */
export function parseConfirmation(reply: string): "yes" | "no" | "unclear" {
  const r = reply.trim().replace(filler(), "").replace(/^[^\w']+/, "");
  if (NO.test(r)) return "no";
  if (YES.test(r) && !/\b(but|except|instead|change|wait|not)\b/i.test(r)) return "yes";
  return "unclear";
}
