import { api } from "@/lib/gateway";
import { cmd, isTauri, type ChatMessage, type DispatchResult } from "@/lib/platform";
import { SUB_AGENTS, classify, type AgentRole } from "./agents";

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
export async function dispatch(text: string, opts: DispatchOptions = {}): Promise<DispatchOutcome> {
  const role = opts.role ?? classify(text);
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
