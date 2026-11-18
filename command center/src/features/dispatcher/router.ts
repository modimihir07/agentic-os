import type { RoutingConfig } from "@/lib/platform";

/**
 * Agent routing resolver (Part 1): turns free text into a `Route` using the
 * user's trigger matrix (`OsConfig.routing`). Pure and deterministic.
 *
 * Mirrors `src-tauri/src/commands/routing.rs` exactly — both sides are
 * checked against the same fixtures (`router.fixtures.json`) so the two
 * implementations can't quietly drift apart. See that file's doc comment
 * for the full algorithm description; this file follows it step for step.
 */

export type RouteKind = "Named" | "Domain" | "Tab" | "Llm" | "Default";
export type Confidence = "high" | "medium" | "low";

export interface Route {
  role: string | null;
  reason: string;
  confidence: Confidence;
  kind: RouteKind;
  /** The request with a resolved delegation phrase stripped (Named kind only); the original text otherwise. */
  task: string;
}

/** Tie-break order for domain scoring. `general` sits last (its own topic
 * triggers are mostly intercepted earlier by the OS-control intent layer). */
export const DOMAIN_TIEBREAK = ["booking", "ops", "coder", "designer", "librarian", "prompter", "general"] as const;

const VERBS_A = ["tell", "ask", "have", "get", "let", "send", "route", "hand", "pass"];
const VERBS_B = ["check", "draft", "find", "look", "search", "tell", "send", "book", "schedule", "fetch", "get", "read", "email", "call", "write", "create", "cancel", "update", "confirm", "fix"];
const NUMBER_WORDS = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];

/** The exact default trigger matrix (mirrors `default_routing_agents()` in os_core.rs). */
export const DEFAULT_ROUTING_CONFIG: RoutingConfig = {
  autoSwitch: true,
  agents: {
    booking: {
      names: ["booking", "booking desk", "booking agent", "casting", "audition", "talent agent", "B&Co"],
      domains: ["whatsapp", "messages", "last 5 messages", "check my texts", "casting call", "self-tape", "wardrobe", "availability", "draft email to agent"],
    },
    prompter: {
      names: ["prompter", "prompt builder", "spec writer", "architect prompt"],
      domains: ["write a prompt", "build a prompt", "break it into phases", "master prompt", "prompt for claude"],
    },
    coder: {
      names: ["coder", "developer", "dev agent", "engineer"],
      domains: ["write code", "fix bug", "tauri", "rust", "typescript", "react", "git commit", "repo", "script", "terminal"],
    },
    designer: {
      names: ["designer", "ui agent", "ux agent"],
      domains: ["ui", "ux", "layout", "css", "color palette", "prototype", "play place", "mockup", "animation"],
    },
    librarian: {
      names: ["librarian", "memory", "vault", "researcher"],
      domains: ["search vault", "rag", "knowledge graph", "find document", "notes", "lookup"],
    },
    ops: {
      names: ["ops", "operations", "business", "finance"],
      domains: ["invoice", "receipt", "bf supplements", "contracting", "quote", "schedule", "calendar", "droplet"],
    },
    general: { names: ["tony"], domains: ["system status", "switch model"] },
  },
};

/**
 * lowercase; strip punctuation except `&`; collapse whitespace; fix the
 * three Whisper mangles the spec calls out ("whats up/app", "what sapp" →
 * "whatsapp"); spell out number words 1..10.
 *
 * NOTE: a matching-only normalization — `Route.task` is built from this
 * normalized text (lower-case, punctuation-stripped), not the original
 * casing/punctuation, to keep this implementation and the Rust one simple
 * and identical. Deliberate, documented simplification.
 */
export function normalize(text: string): string {
  let cleaned = "";
  for (const ch of text) {
    if (/[a-z0-9&]/i.test(ch)) cleaned += ch.toLowerCase();
    else if (/\s/.test(ch)) cleaned += " ";
    // other punctuation: dropped entirely (not replaced by a space), so
    // "what's" normalizes to "whats", not "what s".
  }
  let s = cleaned.split(/\s+/).filter(Boolean).join(" ");
  for (const [from, to] of [
    [" whats up ", " whatsapp "],
    [" whats app ", " whatsapp "],
    [" what sapp ", " whatsapp "],
  ] as const) {
    const padded = ` ${s} `;
    if (padded.includes(from)) s = padded.split(from).join(to).trim();
  }
  return s
    .split(" ")
    .map((w) => {
      const i = NUMBER_WORDS.indexOf(w);
      return i >= 0 ? String(i + 1) : w;
    })
    .join(" ");
}

const tokenize = (s: string): string[] => s.split(" ").filter(Boolean);
const tokAt = (toks: string[], i: number): string | undefined => toks[i];
const roleRank = (role: string): number => {
  const i = (DOMAIN_TIEBREAK as readonly string[]).indexOf(role);
  return i < 0 ? DOMAIN_TIEBREAK.length : i;
};

function namePairs(cfg: RoutingConfig): [string, string][] {
  const out: [string, string][] = [];
  for (const [role, t] of Object.entries(cfg.agents)) {
    for (const n of t.names) {
      const norm = normalize(n);
      if (norm) out.push([role, norm]);
    }
  }
  return out;
}

/** Does one of `names` match starting exactly at `toks[pos..]`? Longest phrase
 * wins on overlap; ties broken by `DOMAIN_TIEBREAK` order. */
function matchNameAt(toks: string[], pos: number, names: [string, string][]): [string, number] | null {
  let best: [string, number] | null = null;
  for (const [role, phrase] of names) {
    const p = tokenize(phrase);
    if (!p.length || pos + p.length > toks.length) continue;
    let ok = true;
    for (let k = 0; k < p.length; k++) if (toks[pos + k] !== p[k]) { ok = false; break; }
    if (!ok) continue;
    const better = !best || p.length > best[1] || (p.length === best[1] && roleRank(role) < roleRank(best[0]));
    if (better) best = [role, p.length];
  }
  return best;
}

function matchNameAnywhere(toks: string[], names: [string, string][]): string | null {
  let best: [string, number] | null = null;
  for (let pos = 0; pos < toks.length; pos++) {
    const m = matchNameAt(toks, pos, names);
    if (!m) continue;
    const better = !best || m[1] > best[1] || (m[1] === best[1] && roleRank(m[0]) < roleRank(best[0]));
    if (better) best = m;
  }
  return best ? best[0] : null;
}

/** Does `phrase` occur as a contiguous run of whole tokens anywhere in `toks`? */
function containsPhrase(toks: string[], phrase: string): boolean {
  const p = tokenize(phrase);
  if (!p.length || p.length > toks.length) return false;
  for (let i = 0; i + p.length <= toks.length; i++) {
    let ok = true;
    for (let k = 0; k < p.length; k++) if (toks[i + k] !== p[k]) { ok = false; break; }
    if (ok) return true;
  }
  return false;
}

function domainScore(toks: string[], domains: string[]): number {
  let score = 0;
  for (const d of domains) {
    const dn = normalize(d);
    if (dn && containsPhrase(toks, dn)) score += dn.length;
  }
  return score;
}

/**
 * Resolve one utterance against the routing matrix. Priority:
 *  (a) explicit delegation pattern → Named, high
 *  (b) any name trigger mentioned anywhere → Named, medium
 *  (c) domain trigger score (longest phrases win; ties → `DOMAIN_TIEBREAK`) → Domain
 *  (d) nothing → Default (the caller decides: keep the current tab, or general)
 */
export function resolve(text: string, cfg: RoutingConfig): Route {
  const original = text.trim();
  const norm = normalize(original);
  const toks = tokenize(norm);
  const names = namePairs(cfg);

  // (a) "tell/ask/have/get/let/send/route/hand/pass (it)? (to)? (my/the/our)? NAME (agent/desk)? (to/about/for)? …"
  for (let i = 0; i < toks.length; i++) {
    if (!VERBS_A.includes(toks[i])) continue;
    let j = i + 1;
    if (tokAt(toks, j) === "it") j += 1;
    if (tokAt(toks, j) === "to") j += 1;
    if (["my", "the", "our"].includes(tokAt(toks, j) ?? "")) j += 1;
    const m = matchNameAt(toks, j, names);
    if (m) {
      const [role, nlen] = m;
      let k = j + nlen;
      if (["agent", "desk"].includes(tokAt(toks, k) ?? "")) k += 1;
      if (["to", "about", "for"].includes(tokAt(toks, k) ?? "")) k += 1;
      const task = toks.slice(k).join(" ");
      return { role, reason: "you named this agent directly", confidence: "high", kind: "Named", task: task || original };
    }
  }
  // (a) "NAME,? (please)? VERB…" — direct address at the start of the utterance.
  const head = matchNameAt(toks, 0, names);
  if (head) {
    const [role, nlen] = head;
    let k = nlen;
    if (tokAt(toks, k) === "please") k += 1;
    const v = tokAt(toks, k);
    if (v !== undefined && VERBS_B.includes(v)) {
      const task = toks.slice(k).join(" ");
      return { role, reason: "you named this agent directly", confidence: "high", kind: "Named", task: task || original };
    }
  }
  // (b) any name trigger mentioned anywhere.
  const mentioned = matchNameAnywhere(toks, names);
  if (mentioned) return { role: mentioned, reason: "this agent was named in the request", confidence: "medium", kind: "Named", task: original };

  // (c) domain triggers.
  let best: [string, number] | null = null;
  for (const role of DOMAIN_TIEBREAK) {
    const t = cfg.agents[role];
    if (!t) continue;
    const score = domainScore(toks, t.domains);
    if (score > 0 && (!best || score > best[1])) best = [role, score];
  }
  if (best) {
    const [role, score] = best;
    return { role, reason: "matched this agent's trigger words", confidence: score >= 6 ? "medium" : "low", kind: "Domain", task: original };
  }
  // (d) nothing matched.
  return { role: null, reason: "no name or trigger matched", confidence: "low", kind: "Default", task: original };
}
