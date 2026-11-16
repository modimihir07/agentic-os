import { cmd, isTauri, type ChatMessage } from "@/lib/platform";
import { SUB_AGENTS, classify, type AgentRole } from "@/features/dispatcher/agents";

/**
 * Master Dispatcher: speech → structured ActionPlan.
 *
 *   1. Heuristic plan (instant, offline) — always computed, used as the floor.
 *   2. Model plan (desktop): the local model returns strict JSON. It may ADD
 *      detail but can never downgrade `mutating` to false (OR with heuristic).
 *   3. Verifier (desktop, mutating only): a separate, verified cloud account
 *      checks the plan against the user's exact words and flags invented
 *      details. A flagged or unverified plan still needs the human's yes.
 *
 * Nothing in this file executes anything.
 */

export type PlanTarget = { kind: "agent" } | { kind: "n8n"; workflow: string };

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

function looksMutating(utterance: string): boolean {
  const s = utterance.trim().replace(FILLER, "");
  if (!MUTATING.test(s) && !COMMAND_VERB.test(s)) return false;
  return !(QUESTION.test(s) && !CHAINED.test(s));
}

const FILLER =/^(hey|ok(ay)?|yo)?[\s,]*(jarvis)?[\s,]*(please|can you|could you|would you|i need you to|i want you to|go ahead and)?[\s,]*/i;

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
  const s = utterance.trim().replace(FILLER, "").replace(/[\s,]*(please|thanks|thank you)[.!?]*$/i, "").replace(/[.!?]+$/, "");
  return toSecondPerson(s.charAt(0).toLowerCase() + s.slice(1));
}

function readBackFor(p: Pick<ActionPlan, "role" | "intent" | "target" | "missing" | "verification">): string {
  const who = p.target.kind === "n8n" ? `running the ${p.target.workflow} workflow` : `instructing ${SUB_AGENTS[p.role].label}`;
  let s = `Got it — ${who} to ${p.intent}.`;
  if (p.missing.length) s += ` I don't have the ${p.missing.slice(0, 2).join(" or ")}.`;
  if (p.verification.status === "flagged") s += " Heads up: the verifier flagged a possible mismatch.";
  return `${s} Proceed?`;
}

export function heuristicPlan(utterance: string, role?: AgentRole): ActionPlan {
  const r = role ?? classify(utterance);
  const intent = cleanIntent(utterance);
  const mutating = looksMutating(utterance);
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

// ── Model planner ────────────────────────────────────────────────────────────

let workflowsCache: string[] | null = null;
async function n8nWorkflows(): Promise<string[]> {
  if (!isTauri()) return [];
  workflowsCache ??= await cmd("n8n_workflows").catch(() => []);
  return workflowsCache;
}

function plannerPrompt(workflows: string[]): string {
  const roles = Object.values(SUB_AGENTS).map((a) => `"${a.role}" (${a.label})`).join(", ");
  return [
    "You are the Master Dispatcher of Jarvis. Convert the user's request into ONE JSON object and nothing else.",
    "Schema:",
    `{"role": one of ${roles},`,
    ` "intent": imperative verb phrase in second person, max 12 words (e.g. "cancel your 7pm dinner with Sam"),`,
    ` "summary": one line for a confirmation card,`,
    ` "mutating": boolean,`,
    workflows.length
      ? ` "target": {"kind":"agent"} or {"kind":"n8n","workflow": one of ${JSON.stringify(workflows)}},`
      : ` "target": {"kind":"agent"},`,
    ` "payload": object of structured fields taken from the request (event, date, time, recipients, subject, body, amount…),`,
    ` "missing": array of required details the user did not give}`,
    "mutating = true if the action would change, send, book, buy, pay, delete, cancel, schedule, post, deploy, start/stop anything, or otherwise affect anything outside this conversation. When unsure: true.",
    "NEVER invent names, dates, times, amounts or recipients. Unknown values go in \"missing\", not in payload.",
  ].join("\n");
}

function extractJson(text: string): Record<string, unknown> | null {
  const a = text.indexOf("{"), b = text.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try {
    const v = JSON.parse(text.slice(a, b + 1));
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
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

  const role = (Object.keys(SUB_AGENTS) as AgentRole[]).includes(j.role as AgentRole) ? (j.role as AgentRole) : base.role;
  const t = j.target as { kind?: string; workflow?: string } | undefined;
  const target: PlanTarget = t?.kind === "n8n" && t.workflow && workflows.includes(t.workflow) ? { kind: "n8n", workflow: t.workflow } : { kind: "agent" };
  const plan: ActionPlan = {
    ...base,
    role,
    intent: toSecondPerson(str(j.intent, 120)) || base.intent,
    summary: str(j.summary) || base.summary,
    // Safety: the model can escalate to mutating, never de-escalate.
    mutating: base.mutating || j.mutating === true || target.kind === "n8n",
    target,
    payload: j.payload && typeof j.payload === "object" && !Array.isArray(j.payload) ? (j.payload as Record<string, unknown>) : {},
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
    try {
      plan = await modelPlan(plan, opts.history ?? []);
    } catch (e) {
      plan.plannerNote = `model planner unavailable (${e instanceof Error ? e.message : e}) — heuristic`;
    }
    if (plan.mutating) {
      plan.verification = await verify(plan);
      plan.readBack = readBackFor(plan);
    }
  } else if (plan.mutating) {
    plan.verification = { status: "unverified", notes: ["Mobile: verifier runs on the desktop only"] };
  }
  return plan;
}

// ── Confirmation replies ────────────────────────────────────────────────────

const YES = /^(yes|yeah|yep|yup|ok(ay)?|sure|do it|go( ahead)?|proceed|confirm(ed)?|approved?|affirmative|send it|make it so|execute)\b/i;
const NO = /^(no|nope|nah|cancel|stop|abort|don'?t|negative|wait|hold (on|up)|never ?mind|scratch that)\b/i;

/** Strict on purpose: "yes, but…" or anything hedged is NOT a yes. */
export function parseConfirmation(reply: string): "yes" | "no" | "unclear" {
  const r = reply.trim().replace(FILLER, "").replace(/^[^\w']+/, "");
  if (NO.test(r)) return "no";
  if (YES.test(r) && !/\b(but|except|instead|change|wait|not)\b/i.test(r)) return "yes";
  return "unclear";
}
