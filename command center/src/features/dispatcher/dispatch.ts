import { api, gateway } from "@/lib/gateway";
import { cmd, isTauri, type ChatMessage, type DispatchResult } from "@/lib/platform";
import { SUB_AGENTS, type AgentRole } from "./agents";
import { DEFAULT_ROUTING_CONFIG, resolve } from "./router";

export interface DispatchOutcome {
  role: AgentRole;
  result: DispatchResult;
}

export interface DispatchOptions {
  role?: AgentRole;
  history?: ChatMessage[];
  /** Force a provider id (desktop only). */
  provider?: string;
}

/**
 * Single entry point for "send this to the agents".
 *
 * Desktop: Rust `dispatch_chat` picks local vs cloud (GPU-load aware), injects
 * API keys from the OS keychain, and reports whether it fell back.
 * PWA:     the Agentic OS gateway (FastAPI) runs the agent; no keys in the browser.
 */
/** Queue a turn for the desktop app and wait for the answer (null if the desktop isn't picking up). */
async function desktopTurn(
  text: string,
  role: AgentRole,
  explicit: boolean,
  routeKind: string,
  routeReason: string,
  history: ChatMessage[],
): Promise<{ answer: string; providerId?: string } | null> {
  const q = await gateway<{ id: string }>("/api/os/inbox", {
    method: "POST",
    body: JSON.stringify({ kind: "turn", payload: { text, role, explicit, routeKind, routeReason, history: history.slice(-8), context: "" } }),
  });
  const t0 = Date.now();
  while (Date.now() - t0 < 240_000) {
    await new Promise((r) => setTimeout(r, 1500));
    const r = await gateway<{ status: string; result: { ok: boolean; result?: { answer?: string; providerId?: string }; error?: string } | null }>(`/api/os/inbox/${q.id}`);
    if (r.status === "pending") {
      if (Date.now() - t0 > 12_000) return null; // desktop app not running → fall back
      continue;
    }
    if (r.result?.ok && r.result.result?.answer) return { answer: r.result.result.answer, providerId: r.result.result.providerId };
    throw new Error(r.result?.error ?? "desktop turn failed");
  }
  return null;
}

export async function dispatch(text: string, opts: DispatchOptions = {}): Promise<DispatchOutcome> {
  // Phone/PWA has no live sync of the user's custom routing matrix yet, so it
  // resolves against the shared defaults — still far better than the old
  // keyword classifier, and "explicit" now means an actually-Named route
  // rather than "any role other than general" (previously *every* classified
  // role was treated as explicit, so a wrong keyword guess went straight to
  // that agent's raw reply with no Tony synthesis or fallback).
  const routed = resolve(text, DEFAULT_ROUTING_CONFIG);
  const role = opts.role ?? (routed.role as AgentRole) ?? "general";
  const explicit = !opts.role && routed.kind === "Named";
  const agent = SUB_AGENTS[role];

  if (isTauri()) {
    const messages: ChatMessage[] = [
      { role: "system", content: agent.systemPrompt },
      ...(opts.history ?? []).slice(-10),
      { role: "user", content: text },
    ];
    const result = await cmd("dispatch_chat", { req: { messages, priority: agent.priority, provider: opts.provider } });
    return { role, result };
  }

  const started = performance.now();
  // Phone: queue the turn for the desktop's OS core (same Tony, tools, sub-agents).
  const viaDesktop = await desktopTurn(text, role, explicit, routed.kind, routed.reason, opts.history ?? []).catch(() => null);
  if (viaDesktop) {
    return {
      role,
      result: { providerId: `desktop:${viaDesktop.providerId ?? "tony"}`, content: viaDesktop.answer, fellBack: false, reason: "phone → desktop Tony", latencyMs: Math.round(performance.now() - started) },
    };
  }
  const res = await api.chat(agent.gatewayAgent, `[${agent.label}] ${text}`);
  return {
    role,
    result: {
      providerId: `gateway:${agent.gatewayAgent}`,
      content: res.response?.content ?? "",
      fellBack: false,
      reason: "PWA → Agentic OS gateway",
      latencyMs: Math.round(performance.now() - started),
    },
  };
}
