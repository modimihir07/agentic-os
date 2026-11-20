import type { LucideIcon } from "lucide-react";
import { Container, Mail, Share2, Workflow } from "lucide-react";
import { cmd, isTauri, type Platform } from "@/lib/platform";

/**
 * Data-stream connectors. Each one is a tiny adapter returning a uniform
 * snapshot, so the Data Streams widget (and future widgets) can render any of
 * them the same way.
 *
 * Add a connector: append to CONNECTORS. Keep secrets in Rust (keychain) — a
 * connector's `fetch` must never receive or return a credential.
 */
export interface StreamItem {
  id: string;
  title: string;
  detail?: string;
  tone: "ok" | "warn" | "down" | "idle";
}

export interface StreamSnapshot {
  status: "connected" | "degraded" | "offline" | "not-configured";
  summary: string;
  items: StreamItem[];
}

export interface Connector {
  id: string;
  label: string;
  icon: LucideIcon;
  platforms: Platform[];
  pollMs: number;
  fetch: () => Promise<StreamSnapshot>;
}

const notConfigured = (summary: string): StreamSnapshot => ({ status: "not-configured", summary, items: [] });

export const CONNECTORS: Connector[] = [
  {
    id: "docker",
    label: "Docker",
    icon: Container,
    platforms: ["desktop"],
    pollMs: 15_000,
    fetch: async () => {
      const list = await cmd("docker_ps");
      const running = list.filter((c) => c.state === "running").length;
      return {
        status: running === list.length ? "connected" : "degraded",
        summary: `${running}/${list.length} running`,
        items: list.map((c) => ({
          id: c.id,
          title: c.name,
          detail: c.status,
          tone: c.state === "running" ? "ok" : c.state === "exited" ? "down" : "warn",
        })),
      };
    },
  },
  {
    id: "netbird",
    label: "NetBird",
    icon: Share2,
    platforms: ["desktop"],
    pollMs: 20_000,
    fetch: async () => {
      const s = await cmd("netbird_status");
      return {
        status: s.connected ? "connected" : "offline",
        summary: s.connected ? `${s.peersConnected}/${s.peersTotal} peers · ${s.ip ?? ""}` : "Disconnected",
        items: [],
      };
    },
  },
  {
    id: "n8n",
    label: "n8n",
    icon: Workflow,
    platforms: ["desktop", "pwa"],
    pollMs: 60_000,
    // TODO(cline): proxy n8n's REST API (GET /api/v1/executions?limit=10) through
    // a Rust command that reads the n8n API key from the keychain.
    fetch: async () => notConfigured("Add n8n URL + API key in Settings"),
  },
  {
    id: "gmail",
    label: "Gmail",
    icon: Mail,
    platforms: ["desktop", "pwa"],
    pollMs: 120_000,
    // TODO(cline): desktop OAuth (loopback redirect, PKCE) handled in Rust, refresh
    // token in the keychain, scope gmail.readonly. PWA reads the digest via the gateway.
    fetch: async () => notConfigured("Connect Google account (OAuth, read-only)"),
  },
];

export const availableConnectors = () => CONNECTORS.filter((c) => c.platforms.includes(isTauri() ? "desktop" : "pwa"));
