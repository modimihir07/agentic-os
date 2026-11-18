import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Check, ChevronDown, Mail, Mic, ShieldAlert, ShieldCheck, ShieldQuestion, Workflow, X } from "lucide-react";
import { SUB_AGENTS } from "@/features/dispatcher/agents";
import { useVoice } from "@/features/voice/voice-store";
import { approve, reject } from "@/features/voice/voice-controller";
import { Waveform } from "@/features/voice/Waveform";

/**
 * High-contrast confirmation gate for every mutating action. Global (portal)
 * so it appears on top of whatever section is open. Approve is never focused
 * by default and has no Enter shortcut. A stray keypress can't send anything.
 */
export function ConfirmCard() {
  const pending = useVoice((s) => s.pending);
  const state = useVoice((s) => s.state);
  const cardRef = useRef<HTMLDivElement>(null);
  const [showPayload, setShowPayload] = useState(false);

  useEffect(() => {
    if (!pending) return;
    setShowPayload(false);
    cardRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") reject("dismissed");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pending?.plan.id]);

  if (!pending) return null;
  const { plan } = pending;
  const agent = SUB_AGENTS[plan.role];
  const AgentIcon = agent.icon;
  const v = plan.verification;
  const listening = state === "listening" || state === "transcribing";

  return createPortal(
    <div className="fixed inset-0 z-[60] grid place-items-center bg-black/45 p-4 backdrop-blur-[2px] animate-[fade-in_180ms_ease-out]">
      <style>{`@keyframes fade-in{from{opacity:0}to{opacity:1}}@keyframes card-in{from{opacity:0;transform:translateY(10px) scale(.97)}to{opacity:1;transform:none}}@keyframes drain{from{transform:scaleX(1)}to{transform:scaleX(0)}}`}</style>
      <div
        ref={cardRef}
        tabIndex={-1}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby="confirm-summary"
        className="w-[min(560px,100%)] overflow-hidden rounded-[22px] border-2 border-amber/80 bg-[#0d0f14]/95 shadow-[0_0_0_1px_rgba(255,179,107,0.25),0_0_60px_-10px_rgba(255,122,47,0.55),0_30px_60px_-20px_rgba(0,0,0,0.9)] outline-none animate-[card-in_240ms_cubic-bezier(0.23,1,0.32,1)]"
      >
        {/* Countdown: drains to zero, then the action cancels itself. */}
        <div className="h-1 bg-white/5">
          <div
            key={plan.id}
            className="h-full origin-left bg-gradient-to-r from-amber to-amber-light"
            style={{ animation: `drain ${Math.max(0, pending.deadline - Date.now())}ms linear forwards` }}
          />
        </div>

        <div className="p-5 sm:p-6">
          <div className="flex items-center gap-2">
            <AlertTriangle size={16} className="text-amber" />
            <h2 id="confirm-title" className="label-caps text-amber">Confirm action</h2>
            <VerificationBadge status={v.status} by={v.by} />
          </div>

          <p id="confirm-summary" className="mt-3 text-[22px] font-semibold leading-snug text-white sm:text-2xl">
            {plan.summary}
          </p>

          <div className="mt-3 flex flex-wrap items-center gap-2 font-mono text-[12px] text-ink-2">
            <span className="flex items-center gap-1.5 rounded-full border border-white/10 px-2.5 py-1">
              <AgentIcon size={12} className="text-teal" /> {agent.label}
            </span>
            <span className="text-ink-3">→</span>
            <span className="flex items-center gap-1.5 rounded-full border border-white/10 px-2.5 py-1">
              {plan.target.kind === "n8n" ? (
                <>
                  <Workflow size={12} className="text-amber-soft" /> n8n · {plan.target.workflow}
                </>
              ) : plan.target.kind === "tool" ? (
                <>
                  <Mail size={12} className="text-amber-soft" /> {plan.target.tool === "gmail.create_draft" ? "Gmail · draft (not sent)" : plan.target.tool}
                </>
              ) : plan.target.kind === "bridge" ? (
                <>
                  <ShieldAlert size={12} className="text-amber-soft" /> Permission Bridge · {plan.target.scopes.join(" + ")}
                </>
              ) : (
                <>Agentic OS · {agent.gatewayAgent}</>
              )}
            </span>
          </div>

          {plan.missing.length > 0 && (
            <p className="mt-3 rounded-[12px] border border-amber/30 bg-amber/10 px-3 py-2 text-sm text-amber-light">
              Not specified: {plan.missing.join(", ")}
            </p>
          )}
          {v.status === "flagged" && (
            <ul className="mt-3 space-y-1 rounded-[12px] border border-alert/40 bg-alert/10 px-3 py-2 text-sm text-[#ffb4ab]">
              {v.notes.map((n, i) => (
                <li key={i}>• {n}</li>
              ))}
            </ul>
          )}

          {Object.keys(plan.payload).length > 0 && (
            <div className="mt-3">
              <button onClick={() => setShowPayload((s) => !s)} className="label-caps flex items-center gap-1 text-ink-3 hover:text-ink-2" aria-expanded={showPayload}>
                <ChevronDown size={12} className={`transition-transform ${showPayload ? "rotate-180" : ""}`} /> Payload
              </button>
              {showPayload && (
                <pre className="well mt-2 max-h-40 overflow-auto rounded-[12px] p-3 font-mono text-[11px] leading-relaxed text-ink-2">
                  {JSON.stringify(plan.payload, null, 2)}
                </pre>
              )}
            </div>
          )}

          <p className="mt-3 font-mono text-[11px] text-ink-3">
            “{plan.utterance}” · {plan.planner === "model" ? `planned by ${plan.plannerNote}` : (plan.plannerNote ?? "heuristic plan")}
          </p>
        </div>

        <div className="flex items-center gap-3 border-t border-white/10 bg-white/[0.02] px-5 py-4 sm:px-6">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <Mic size={14} className={listening ? "shrink-0 text-teal" : "shrink-0 text-ink-3"} />
            {listening ? (
              <Waveform state="listening" height={28} className="max-w-40" />
            ) : (
              <span className="truncate text-xs text-ink-2">
                Say <b className="text-ink">“yes”</b> or <b className="text-ink">“no”</b>
              </span>
            )}
          </div>
          <button onClick={() => reject("declined")} className="pill-glass shrink-0">
            <X size={15} /> Cancel
          </button>
          <button onClick={() => void approve("tap")} className="pill-primary shrink-0">
            <Check size={15} /> Approve
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function VerificationBadge({ status, by }: { status: string; by?: string }) {
  const map = {
    verified: { icon: ShieldCheck, cls: "border-teal/40 text-teal", text: "Verified" },
    flagged: { icon: ShieldAlert, cls: "border-alert/50 text-alert", text: "Flagged" },
    unverified: { icon: ShieldQuestion, cls: "border-white/15 text-ink-2", text: "Unverified" },
    skipped: { icon: ShieldQuestion, cls: "border-white/15 text-ink-3", text: "Not checked" },
  } as const;
  const m = map[status as keyof typeof map] ?? map.skipped;
  const Icon = m.icon;
  return (
    <span title={by ? `Checked by ${by}` : undefined} className={`label-caps ml-auto flex items-center gap-1 rounded-full border px-2 py-0.5 ${m.cls}`}>
      <Icon size={11} /> {m.text}
    </span>
  );
}
