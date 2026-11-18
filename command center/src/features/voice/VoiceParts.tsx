import { useEffect, useRef, useState } from "react";
import { ArrowRight, Mic, Send, Square } from "lucide-react";
import { useThreadTurns, useVoice, type ThreadId, type VoiceState } from "./voice-store";
import { askOverseer, handleInput, runTurnAction, toggleListening } from "./voice-controller";
import { useFocus } from "@/features/os/focus-store";
import { SUB_AGENTS, type AgentRole } from "@/features/dispatcher/agents";
import { agentBadge, useOsName } from "@/features/os/os-store";
import { isTauri } from "@/lib/platform";
import { useNav } from "@/stores/nav";

/** Shared building blocks for the floating HUD, the Voice Console widget and the Agents section. */

export const STATE_DOT: Record<VoiceState, string> = {
  idle: "bg-ink-3",
  listening: "bg-teal shadow-[0_0_10px_#00e5c3]",
  transcribing: "bg-teal shadow-[0_0_10px_#00e5c3] animate-pulse",
  thinking: "bg-amber shadow-[0_0_10px_#ff7a2f] animate-pulse",
  confirming: "bg-amber shadow-[0_0_10px_#ff7a2f]",
  speaking: "bg-volt shadow-[0_0_10px_#00f0ff]",
  error: "bg-alert",
};

export function MicButton({ size = 44 }: { size?: number }) {
  const state = useVoice((s) => s.state);
  const live = state === "listening" || state === "speaking";
  return (
    <button
      aria-label={state === "listening" ? "Stop listening" : state === "speaking" ? "Stop speaking" : "Start listening"}
      onClick={toggleListening}
      style={{ width: size, height: size }}
      className={`grid shrink-0 place-items-center rounded-full transition-transform duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] active:scale-95 ${
        live ? "bg-teal text-canvas glow-teal" : "pill-primary !p-0"
      }`}
      // pill-primary sets its own height; the inline size wins.
    >
      {live ? <Square size={size * 0.34} fill="currentColor" /> : <Mic size={size * 0.4} />}
    </button>
  );
}

export function Transcript({ max = 50, className = "", thread }: { max?: number; className?: string; thread?: ThreadId }) {
  const turns = useThreadTurns(thread).slice(-max);
  const name = useOsName();
  const end = useRef<HTMLDivElement>(null);
  const desktop = isTauri();
  // Braces matter: newer Chromium returns a Promise from scrollIntoView, and an
  // effect must not return anything but a cleanup function.
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [turns.length]);
  if (!turns.length) return null;
  const openThread = (t: ThreadId) => {
    useVoice.getState().setActiveThread(t);
    useNav.getState().go("agents");
  };
  return (
    <div className={`space-y-3 overflow-y-auto ${className}`} aria-live="polite">
      {turns.map((t) => {
        if (t.who === "system")
          return (
            <p key={t.id} className={`font-mono text-[11px] ${t.tone === "error" ? "text-alert" : t.tone === "warn" ? "text-amber-soft" : "text-teal"}`}>
              — {t.text}
            </p>
          );
        if (t.who === "relay")
          return (
            <div key={t.id} className={`rounded-[12px] border px-3 py-2 text-[13px] ${t.tone === "warn" ? "border-amber/30 bg-amber/[0.05]" : "border-volt/20 bg-volt/[0.04]"}`}>
              <div className="mb-1 flex flex-wrap items-center gap-1.5">
                <span className="rounded-full bg-white/10 px-2 py-0.5 font-mono text-[10px] font-semibold tracking-wider text-ink">{agentBadge(t.from ?? "os")}</span>
                <ArrowRight size={11} className="text-ink-3" />
                <span className="rounded-full bg-white/10 px-2 py-0.5 font-mono text-[10px] font-semibold tracking-wider text-ink">{agentBadge(t.to ?? "user")}</span>
                {t.meta && <span className="font-mono text-[10px] text-ink-3">{t.meta}</span>}
              </div>
              <p className="whitespace-pre-wrap break-words text-ink-2">{t.text}</p>
            </div>
          );
        const sender = t.who === "user" ? "Query" : t.from === "overseer" ? "Overseer" : t.from && t.from !== "os" ? agentBadge(t.from) : name;
        return (
          <div key={t.id} className="group grid grid-cols-[72px_1fr] gap-3 text-sm">
            <span className={`label-caps truncate pt-0.5 ${t.who === "user" ? "text-amber" : t.from === "overseer" ? "text-volt" : "text-teal"}`} title={sender}>
              {sender}
            </span>
            <div className="min-w-0">
              <p className={`whitespace-pre-wrap break-words ${t.who === "user" ? "italic text-ink" : "text-ink"}`}>{t.text}</p>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                {t.meta && <span className="font-mono text-[11px] text-ink-3">{t.meta}</span>}
                {t.link && (
                  <button onClick={() => openThread(t.link!)} className="rounded-full border border-teal/40 bg-teal/10 px-2.5 py-0.5 text-[11px] text-teal hover:bg-teal/20">
                    View in {t.link === "general" ? name : SUB_AGENTS[t.link as AgentRole]?.label ?? t.link} →
                  </button>
                )}
                {t.commsThread && (
                  <button
                    onClick={() => (useFocus.getState().set({ commsThread: t.commsThread }), useNav.getState().go("comms"))}
                    className="rounded-full border border-volt/40 bg-volt/10 px-2.5 py-0.5 text-[11px] text-volt hover:bg-volt/20"
                  >
                    Jump to Thread in Comms →
                  </button>
                )}
                {t.cardId && (
                  <button
                    onClick={() => (useFocus.getState().set({ card: t.cardId }), useNav.getState().go("playplace"))}
                    className="rounded-full border border-amber/40 bg-amber/10 px-2.5 py-0.5 text-[11px] text-amber-light hover:bg-amber/20"
                  >
                    Open in Play Place →
                  </button>
                )}
                {t.actions?.map((a) => (
                  <button key={a.run} onClick={() => runTurnAction(a.run, t.thread)} className={a.run.startsWith("pipeline:") ? "pill-primary !h-7 !px-3 text-[11px]" : "pill-glass !h-7 !px-3 text-[11px]"}>
                    {a.label}
                  </button>
                ))}
                {desktop && t.who === "agent" && t.from !== "overseer" && (
                  <button
                    onClick={() => void askOverseer(t)}
                    className="rounded-full border border-white/10 px-2.5 py-0.5 text-[11px] text-ink-3 opacity-70 transition-opacity hover:text-ink group-hover:opacity-100"
                    title="Escalate this answer to the Overseer (Claude / Gemini / droplet — Settings → Integrations)"
                  >
                    Ask Overseer
                  </button>
                )}
              </div>
            </div>
          </div>
        );
      })}
      <div ref={end} />
    </div>
  );
}

export function CommandInput({ thread, placeholder = "Type a command for the dispatcher…", autoFocus }: { thread?: ThreadId; placeholder?: string; autoFocus?: boolean }) {
  const [text, setText] = useState("");
  const state = useVoice((s) => s.state);
  const pending = useVoice((s) => !!s.pending);
  const busy = state === "thinking" || state === "transcribing";
  return (
    <form
      className="flex items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        const t = text.trim();
        if (!t || busy) return;
        setText("");
        void handleInput(t, { channel: "text", thread });
      }}
    >
      <input
        className="field h-10 !rounded-full"
        autoFocus={autoFocus}
        aria-label="Command"
        placeholder={pending ? "Type yes or no…" : placeholder}
        value={text}
        onChange={(e) => setText(e.target.value)}
        disabled={busy}
      />
      <button type="submit" aria-label="Send" className="pill-glass !h-10 !w-10 shrink-0 !p-0" disabled={busy || !text.trim()}>
        <Send size={16} />
      </button>
    </form>
  );
}
