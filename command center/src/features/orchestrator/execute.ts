import { api, GatewayError } from "@/lib/gateway";
import { cc } from "@/lib/cc-api";
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
 *   mutating + tool  → that tool's approved-only Rust command (gmail_create_draft)
 *   mutating + agent → Agentic OS agent via the gateway (opencode has real
 *                      tools). A plain chat model has NO tools and would
 *                      only *claim* it acted, so it is never used to
 *                      "execute" a mutating action. Before sending, the
 *                      agent's health is checked so an uninstalled CLI never
 *                      shows a fake reply.
 */
export async function execute(plan: ActionPlan, history: ChatMessage[]): Promise<ExecutionResult> {
  const agent = SUB_AGENTS[plan.role];

  // Permission-Bridge actions carry their own (already approved) runner.
  if (plan.run) return plan.run();

  if (!plan.mutating && plan.target.kind === "n8n") {
    // Read-only workflow (e.g. calendar-upcoming): Rust refuses this for mutating ones.
    const started = performance.now();
    const out = await cmd("n8n_fetch", { name: plan.target.workflow, payload: { ...plan.payload, utterance: plan.utterance } });
    return {
      text: summariseOutput(typeof out === "string" ? out : JSON.stringify(out)),
      meta: `n8n · ${plan.target.workflow} (read-only) · ${Math.round(performance.now() - started)}ms`,
    };
  }

  if (!plan.mutating) {
    // Librarian answers from your own vault (receipts, notes, scripts…) when it can.
    let utterance = plan.utterance;
    let vaultNote = "";
    if (plan.role === "librarian") {
      const hits = await cc.search(plan.utterance, [], 5).catch(() => null);
      if (hits?.results.length) {
        utterance = `${plan.utterance}\n\nRelevant entries from my local vault (cite them; say if they don't answer it):\n${hits.results
          .map((r, i) => `[${i + 1}] (${r.collection}) ${r.snippet.replace(/\s+/g, " ")}`)
          .join("\n")}`;
        vaultNote = ` · vault ${hits.results.length} (${hits.mode})`;
      }
    }
    const { result } = await dispatch(utterance, { role: plan.role, history });
    return {
      text: result.content || "(no response)",
      meta: `${agent.label} · ${result.providerId}${result.fellBack ? " · fallback" : ""}${vaultNote} · ${result.latencyMs}ms`,
    };
  }

  if (plan.target.kind === "tool") return runTool(plan.target.tool, plan.target.args);

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

  // Guard: never send to a gateway agent that isn't installed — fail with a plain
  // message instead of letting the gateway's "⚠ CLI not installed" text show as a
  // reply (server.py now returns 503 for that too; this check avoids the round trip).
  const health = await api.agentsHealth().catch(() => null);
  const status = health?.agents.find((a) => a.name === agent.gatewayAgent)?.status;
  if (status && status !== "online") {
    throw new Error(`Nothing was done — the ${agent.gatewayAgent} CLI isn't installed.`);
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
    if (e instanceof GatewayError && e.status === 503) {
      throw new Error(`Nothing was done — the ${agent.gatewayAgent} CLI isn't installed.`);
    }
    throw new Error(`Executor unreachable (${e instanceof Error ? e.message : e}) — nothing was done.`);
  });
  return {
    text: res.response?.content || "(no response)",
    meta: `${agent.label} → Agentic OS · ${agent.gatewayAgent} · ${Math.round(performance.now() - started)}ms`,
  };
}

/** An approved tool plan: each tool has its own Rust command that refuses without `approved`. */
async function runTool(tool: string, args: Record<string, unknown>): Promise<ExecutionResult> {
  if (tool !== "gmail.create_draft") throw new Error(`Nothing was done — ${tool} has no approved-action path.`);
  const started = performance.now();
  const s = (k: string) => (typeof args[k] === "string" ? (args[k] as string) : "");
  const text = await cmd("gmail_create_draft", { to: s("to"), subject: s("subject"), body: s("body"), approved: true }).catch((e) => {
    const raw = e instanceof Error ? e.message : String(e);
    throw new Error(raw.startsWith("PERMISSION_DENIED") ? "Nothing was done — MCP tools are set to Deny in Settings → Integrations." : `No draft was saved — ${raw}`);
  });
  return { text, meta: `Gmail · draft · ${Math.round(performance.now() - started)}ms` };
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
