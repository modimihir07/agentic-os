import { StatusDot, WidgetHeader } from "@/components/WidgetHeader";
import { api } from "@/lib/gateway";
import { cmd, isTauri } from "@/lib/platform";
import { usePoll } from "@/lib/use-poll";

export default function AgentNodes() {
  const health = usePoll(() => api.agentsHealth(), 30_000);
  const providers = usePoll(() => (isTauri() ? cmd("providers_list") : Promise.resolve([])), 30_000);
  const agents = health.data?.agents ?? [];
  const online = agents.filter((a) => a.status === "online" || a.status === "available").length;

  return (
    <div>
      <WidgetHeader
        title="Active nodes"
        status={<StatusDot tone={health.error ? "down" : online ? "ok" : "idle"} label={health.error ? "Gateway down" : `${online}/${agents.length} up`} />}
      />
      <ul className="space-y-1.5">
        {(providers.data ?? []).map((p) => (
          <Node
            key={p.id}
            name={p.label}
            detail={p.model}
            tag={p.kind === "local" ? "LOCAL" : p.kind === "cloud" ? "CLOUD" : "AGENT"}
            tone={p.needsKey && !p.hasKey ? "warn" : "ok"}
            note={p.needsKey && !p.hasKey ? "no key" : undefined}
          />
        ))}
        {agents.map((a) => (
          <Node key={a.name} name={a.name} detail={a.version ?? a.status} tag="AOS" tone={a.status === "online" || a.status === "available" ? "ok" : "down"} />
        ))}
        {!agents.length && !providers.data?.length && (
          <li className="text-sm text-ink-3">{health.error ? "Start server.py or set the gateway URL in Settings." : "Discovering…"}</li>
        )}
      </ul>
    </div>
  );
}

function Node({ name, detail, tag, tone, note }: { name: string; detail: string; tag: string; tone: "ok" | "warn" | "down"; note?: string }) {
  const dot = { ok: "bg-teal shadow-[0_0_6px_#00e5c3]", warn: "bg-amber", down: "bg-alert" }[tone];
  return (
    <li className="flex items-center gap-2.5 rounded-full border border-white/[0.06] bg-white/[0.02] px-3 py-1.5">
      <span className={`size-1.5 shrink-0 rounded-full ${dot}`} />
      <span className="truncate font-mono text-[13px] text-ink">{name}</span>
      <span className="truncate font-mono text-[11px] text-ink-3">{note ?? detail}</span>
      <span className="label-caps ml-auto shrink-0 text-amber-soft">{tag}</span>
    </li>
  );
}
