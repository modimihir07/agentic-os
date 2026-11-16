import type { LucideIcon } from "lucide-react";
import { BookOpen, CalendarCheck, Code2, Radar, Sparkles } from "lucide-react";
import type { Priority } from "@/lib/platform";

/**
 * Sub-agent catalogue. The dispatcher picks one per request, prepends its
 * system prompt, and hands the request to the Rust routing policy, which picks
 * the *provider* (local GGUF via LM Studio / AnythingLLM, or the cloud droplet).
 *
 * Add an agent: append an entry here. Nothing else needs to change.
 */
export type AgentRole = "librarian" | "coder" | "booking" | "ops" | "general";

export interface SubAgent {
  role: AgentRole;
  label: string;
  icon: LucideIcon;
  /** Agentic OS backend agent to use when running as a PWA via the gateway. */
  gatewayAgent: "opencode" | "hermes" | "agy";
  priority: Priority;
  keywords: string[];
  systemPrompt: string;
}

const GUARDRAIL =
  "Never send messages, make purchases, book, pay, delete, or change accounts yourself. " +
  "Propose the exact action and wait for the user's explicit confirmation.";

export const SUB_AGENTS: Record<AgentRole, SubAgent> = {
  librarian: {
    role: "librarian",
    label: "Librarian",
    icon: BookOpen,
    gatewayAgent: "agy",
    priority: "interactive",
    keywords: ["find", "search", "summar", "email", "gmail", "doc", "note", "remember", "research", "what did", "file"],
    systemPrompt: `You are Librarian, the knowledge and retrieval agent of Jarvis. You search the user's files, notes, email digests and memory, cite where each fact came from, and say plainly when something is not found. ${GUARDRAIL}`,
  },
  coder: {
    role: "coder",
    label: "Coder",
    icon: Code2,
    gatewayAgent: "opencode",
    priority: "interactive",
    keywords: ["code", "bug", "build", "deploy", "refactor", "test", "repo", "git", "function", "error", "compile"],
    systemPrompt: `You are Coder, the software agent of Jarvis. Be precise and terse; prefer diffs and runnable commands. ${GUARDRAIL}`,
  },
  booking: {
    role: "booking",
    label: "Booking Desk",
    icon: CalendarCheck,
    gatewayAgent: "hermes",
    priority: "interactive",
    keywords: [
      "book", "reserve", "reservation", "schedule", "meeting", "calendar", "event", "appointment", "remind",
      "flight", "hotel", "dinner", "lunch", "breakfast", "table", "rsvp", "invite",
    ],
    systemPrompt: `You are Booking Desk, the scheduling agent of Jarvis. Gather date, time, place and party size, then present one clear proposal. ${GUARDRAIL}`,
  },
  ops: {
    role: "ops",
    label: "Ops",
    icon: Radar,
    gatewayAgent: "hermes",
    priority: "background",
    keywords: ["docker", "container", "netbird", "n8n", "workflow", "webhook", "droplet", "server", "uptime", "gpu", "vram"],
    systemPrompt: `You are Ops, the infrastructure agent of Jarvis. Report status as short telemetry lines; flag anything degraded first. ${GUARDRAIL}`,
  },
  general: {
    role: "general",
    label: "Jarvis",
    icon: Sparkles,
    // Hermes owns channels, schedules and skills — the best general executor.
    gatewayAgent: "hermes",
    priority: "interactive",
    keywords: [],
    systemPrompt: `You are Jarvis, a calm, concise voice assistant. Answer in one to three sentences unless asked for detail. ${GUARDRAIL}`,
  },
};

/**
 * Cheap keyword classifier — instant and offline. TODO(cline): replace with a
 * tiny local model call (e.g. Llama 3.2 1B via LM Studio, JSON-mode) once the
 * dispatcher model is chosen; keep this as the fallback.
 */
export function classify(text: string): AgentRole {
  const t = text.toLowerCase();
  let best: AgentRole = "general";
  let bestScore = 0;
  for (const agent of Object.values(SUB_AGENTS)) {
    const score = agent.keywords.reduce((n, k) => n + (t.includes(k) ? 1 : 0), 0);
    if (score > bestScore) {
      best = agent.role;
      bestScore = score;
    }
  }
  return best;
}
