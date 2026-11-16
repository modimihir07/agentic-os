import { api } from "@/lib/gateway";
import { cmd, type ChatMessage } from "@/lib/platform";
import { SUB_AGENTS } from "@/features/dispatcher/agents";
import { dispatch } from "@/features/dispatcher/dispatch";
import type { ActionPlan } from "./plan";

export interface ExecutionResult {
  text: string;
  meta: string;
}

/**
 * Run a plan. Only call this for read-only plans, or for mutating plans the
 * human has approved. The ONLY caller is the controller's approval path.
 *
 * Routing:
 *   read-only        → dispatch() chat (local model / cloud fallback / gateway)
 *   mutating + n8n   → named n8n webhook (Rust, URL from providers.json)
 *   mutating + agent → Agentic OS agent via the gateway (hermes/opencode/agy
 *                      have real tools). A plain chat model has NO tools and
 *                      would only *claim* it acted, so it is never used to
 *                      "execute" a mutating action.
 */
export async function execute(plan: ActionPlan, history: ChatMessage[]): Promise<ExecutionResult> {
  const agent = SUB_AGENTS[plan.role];

  if (!plan.mutating) {
    const { result } = await dispatch(plan.utterance, { role: plan.role, history });
    return {
      text: result.content || "(no response)",
      meta: `${agent.label} · ${result.providerId}${result.fellBack ? " · fallback" : ""} · ${result.latencyMs}ms`,
    };
  }

  if (plan.target.kind === "n8n") {
    const started = performance.now();
    const out = await cmd("n8n_trigger", {
      name: plan.target.workflow,
      payload: { ...plan.payload, intent: plan.intent, summary: plan.summary, utterance: plan.utterance, approvedAt: new Date().toISOString() },
    });
    return {
      text: `Done — the ${plan.target.workflow} workflow ran.${out ? ` ${summariseOutput(out)}` : ""}`,
      meta: `n8n · ${plan.target.workflow} · ${Math.round(performance.now() - started)}ms`,
    };
  }

  const started = performance.now();
  const message = [
    `[${agent.label} — action APPROVED by the user]`,
    `Action: ${plan.summary}`,
    `Details: ${JSON.stringify(plan.payload)}`,
    `Original request: "${plan.utterance}"`,
    "Carry out exactly this action and nothing more. If you cannot complete it, say so plainly — do not claim success. Reply in one or two sentences.",
  ].join("\n");
  const res = await api.chat(agent.gatewayAgent, message).catch((e) => {
    throw new Error(`Executor unreachable (${e instanceof Error ? e.message : e}) — nothing was done.`);
  });
  return {
    text: res.response?.content || "(no response)",
    meta: `${agent.label} → Agentic OS · ${agent.gatewayAgent} · ${Math.round(performance.now() - started)}ms`,
  };
}

function summariseOutput(raw: string): string {
  try {
    const j = JSON.parse(raw);
    const msg = j?.message ?? j?.result ?? j?.status;
    if (typeof msg === "string") return msg.slice(0, 200);
  } catch {
    /* plain text */
  }
  return raw.replace(/\s+/g, " ").slice(0, 200);
}
