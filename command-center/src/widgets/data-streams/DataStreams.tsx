import { WidgetHeader } from "@/components/WidgetHeader";
import { availableConnectors, type Connector, type StreamSnapshot } from "@/features/streams/connectors";
import { usePoll } from "@/lib/use-poll";

export default function DataStreams() {
  const connectors = availableConnectors();
  return (
    <div>
      <WidgetHeader title="Data streams" status={<span className="label-caps text-ink-3">{connectors.length} feeds</span>} />
      <ul className="space-y-2">
        {connectors.map((c) => (
          <ConnectorRow key={c.id} c={c} />
        ))}
      </ul>
    </div>
  );
}

const STATUS_TONE: Record<StreamSnapshot["status"], string> = {
  connected: "text-teal",
  degraded: "text-amber",
  offline: "text-alert",
  "not-configured": "text-ink-3",
};

function ConnectorRow({ c }: { c: Connector }) {
  const { data, error } = usePoll(c.fetch, c.pollMs);
  const Icon = c.icon;
  const status = error ? "offline" : (data?.status ?? "not-configured");
  return (
    <li className="rounded-[14px] border border-white/[0.06] bg-white/[0.02] p-2.5">
      <div className="flex items-center gap-2">
        <Icon size={14} className={STATUS_TONE[status]} />
        <span className="text-sm font-medium text-ink">{c.label}</span>
        <span className="ml-auto truncate font-mono text-[11px] text-ink-3">{error ? "unavailable" : (data?.summary ?? "…")}</span>
      </div>
      {!!data?.items.length && (
        <ul className="mt-2 space-y-1 border-t border-white/5 pt-2">
          {data.items.slice(0, 5).map((it) => (
            <li key={it.id} className="flex items-center gap-2 font-mono text-[11px]">
              <span className={`size-1 rounded-full ${it.tone === "ok" ? "bg-teal" : it.tone === "warn" ? "bg-amber" : it.tone === "down" ? "bg-alert" : "bg-ink-3"}`} />
              <span className="truncate text-ink-2">{it.title}</span>
              <span className="ml-auto shrink-0 text-ink-3">{it.detail}</span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}
