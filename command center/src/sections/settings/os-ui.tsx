import { useEffect, useState, type ReactNode } from "react";
import { KeyRound, Trash2 } from "lucide-react";
import { Input } from "@/components/ui";
import { cmd, type OsConfig, type OsSecret, type Tier } from "@/lib/platform";
import { useOs } from "@/features/os/os-store";
import { notifyIntegrationsChanged } from "@/features/integrations/changed";

/** OS config + patcher; loads once on first use. */
export function useOsCfg() {
  const cfg = useOs((s) => s.cfg);
  const error = useOs((s) => s.error);
  const saving = useOs((s) => s.saving);
  const patch = useOs((s) => s.patch);
  useEffect(() => {
    if (!useOs.getState().cfg) void useOs.getState().load();
  }, []);
  /** Patch and swallow (errors surface in `error`). */
  const save = (p: Parameters<typeof patch>[0]) => void patch(p).catch(() => undefined);
  return { cfg, error, saving, save };
}

export function Toggle({ on, onChange, label, hint, tone = "teal", disabled }: { on: boolean; onChange: (v: boolean) => void; label: ReactNode; hint?: ReactNode; tone?: "teal" | "amber" | "alert"; disabled?: boolean }) {
  const bg = tone === "alert" ? "bg-alert/90" : tone === "amber" ? "bg-amber/80" : "bg-teal/80";
  return (
    <label className={`flex items-start gap-3 py-1.5 text-sm ${disabled ? "opacity-50" : "cursor-pointer"}`}>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        disabled={disabled}
        onClick={() => onChange(!on)}
        className={`relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors ${on ? bg : "bg-white/15"}`}
      >
        <span className={`absolute top-0.5 size-4 rounded-full bg-white shadow transition-[left] duration-200 ${on ? "left-[18px]" : "left-0.5"}`} />
      </button>
      <span className="min-w-0">
        <span className="text-ink">{label}</span>
        {hint && <span className="block text-xs leading-relaxed text-ink-3">{hint}</span>}
      </span>
    </label>
  );
}

const TIERS: Tier[] = ["allow", "ask", "deny"];
export function TierSelect({ value, onChange, label, hint }: { value: Tier; onChange: (t: Tier) => void; label: string; hint?: string }) {
  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-white/5 py-2.5 last:border-0">
      <div className="min-w-0 flex-1">
        <p className="text-sm text-ink">{label}</p>
        {hint && <p className="text-xs text-ink-3">{hint}</p>}
      </div>
      <div role="radiogroup" aria-label={label} className="well flex rounded-full p-0.5">
        {TIERS.map((t) => (
          <button
            key={t}
            role="radio"
            aria-checked={value === t}
            onClick={() => value !== t && onChange(t)}
            className={`h-7 rounded-full px-3 font-mono text-[11px] uppercase tracking-wider transition-colors ${
              value === t ? (t === "allow" ? "bg-teal/25 text-teal" : t === "ask" ? "bg-amber/25 text-amber-light" : "bg-alert/25 text-alert") : "text-ink-3 hover:text-ink"
            }`}
          >
            {t}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Set / replace / delete an OS-level secret. The value is never read back. */
export function SecretRow({ name, label, placeholder, hint, onChange }: { name: OsSecret; label: string; placeholder?: string; hint?: string; onChange?: () => void }) {
  const [has, setHas] = useState<boolean | null>(null);
  const [val, setVal] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const refresh = () => void cmd("os_secret_status").then((s) => setHas(!!s[name])).catch(() => setHas(null));
  useEffect(refresh, [name]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="py-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <KeyRound size={13} className={has ? "text-teal" : "text-ink-3"} />
        <span className="text-sm text-ink">{label}</span>
        <span className={`label-caps ${has ? "text-teal" : "text-ink-3"}`}>{has === null ? "…" : has ? "saved in keychain" : "not set"}</span>
        <form
          className="ml-auto flex min-w-[240px] flex-1 gap-1.5 sm:flex-none"
          onSubmit={(e) => {
            e.preventDefault();
            if (!val.trim()) return;
            void cmd("os_secret_set", { name, value: val })
              .then(() => (setVal(""), setMsg(null), refresh(), onChange?.(), notifyIntegrationsChanged()))
              .catch((er) => setMsg(String(er)));
          }}
        >
          <Input type="password" autoComplete="off" value={val} onChange={(e) => setVal(e.target.value)} placeholder={placeholder ?? (has ? "Replace…" : "Paste key…")} className="!h-9 !py-1 font-mono !text-[12px]" />
          <button className="pill-glass !h-9 text-xs" disabled={!val.trim()}>
            Save
          </button>
          {has && (
            <button type="button" aria-label={`Delete ${label}`} onClick={() => void cmd("os_secret_delete", { name }).then(() => (refresh(), onChange?.(), notifyIntegrationsChanged()))} className="pill-glass !h-9 !w-9 !p-0 hover:!border-alert/50">
              <Trash2 size={13} />
            </button>
          )}
        </form>
      </div>
      {hint && <p className="mt-1 text-xs text-ink-3">{hint}</p>}
      {msg && <p className="mt-1 text-xs text-alert">{msg}</p>}
    </div>
  );
}

export function CfgError({ error }: { error: string | null }) {
  return error ? <p className="mt-2 rounded-[10px] border border-alert/30 bg-alert/10 px-3 py-2 text-xs text-alert">{error}</p> : null;
}

export type { OsConfig };
