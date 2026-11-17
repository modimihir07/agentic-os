/**
 * Client for the existing Agentic OS FastAPI backend (server.py, default :8080).
 * On desktop it runs next to the app; on mobile the PWA reaches it over NetBird.
 */
import { useSettings } from "@/stores/settings";

export class GatewayError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

export async function gateway<T>(path: string, init?: RequestInit & { timeoutMs?: number }): Promise<T> {
  const { gatewayUrl, gatewayToken } = useSettings.getState();
  const base = gatewayUrl.replace(/\/+$/, "");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), init?.timeoutMs ?? 15_000);
  try {
    const res = await fetch(`${base}${path}`, {
      ...init,
      signal: ctrl.signal,
      headers: { "Content-Type": "application/json", ...authHeader(gatewayToken), ...(init?.headers ?? {}) },
    });
    if (!res.ok) throw new GatewayError(`${res.status} ${res.statusText}`, res.status);
    return (await res.json()) as T;
  } catch (err) {
    if (err instanceof GatewayError) throw err;
    throw new GatewayError(err instanceof Error && err.name === "AbortError" ? "Gateway timed out" : "Gateway unreachable");
  } finally {
    clearTimeout(timer);
  }
}

/** Network lock: the phone presents the gateway token (the desktop on loopback doesn't need it). */
export const authHeader = (token: string): Record<string, string> => (token.trim() ? { Authorization: `Bearer ${token.trim()}` } : {});

// ── Typed endpoints (see server.py) ──────────────────────────────────────────

export interface AgentHealth {
  name: string;
  status: string;
  version?: string;
  success_rate?: number;
  last_seen?: string;
}

export const api = {
  status: () => gateway<Record<string, unknown>>("/api/status"),
  agentsHealth: () => gateway<{ agents: AgentHealth[]; updated: string }>("/api/agents/health"),
  routerSuggest: (task: string) =>
    gateway<{ suggested_agent: string; confidence: string }>("/api/router/suggest", {
      method: "POST",
      body: JSON.stringify({ task }),
    }),
  chat: (agent: "opencode" | "hermes" | "agy", message: string) =>
    gateway<{ status: string; response: { content: string; agent: string; timestamp: string } }>("/api/chat", {
      method: "POST",
      body: JSON.stringify({ agent, message }),
      timeoutMs: 180_000,
    }),
};
