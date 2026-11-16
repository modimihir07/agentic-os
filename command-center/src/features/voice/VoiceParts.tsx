import { useEffect, useRef, useState } from "react";
import { Mic, Send, Square } from "lucide-react";
import { useVoice, type VoiceState } from "./voice-store";
import { handleInput, toggleListening } from "./voice-controller";
import type { AgentRole } from "@/features/dispatcher/agents";

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

export function Transcript({ max = 50, className = "" }: { max?: number; className?: string }) {
  const turns = useVoice((s) => s.turns).slice(-max);
  const end = useRef<HTMLDivElement>(null);
  // Braces matter: newer Chromium returns a Promise from scrollIntoView, and an
  // effect must not return anything but a cleanup function.
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [turns.length]);
  if (!turns.length) return null;
  return (
    <div className={`space-y-3 overflow-y-auto ${className}`} aria-live="polite">
      {turns.map((t) =>
        t.who === "system" ? (
          <p
            key={t.id}
            className={`font-mono text-[11px] ${t.tone === "error" ? "text-alert" : t.tone === "warn" ? "text-amber-soft" : "text-teal"}`}
          >
            — {t.text}
          </p>
        ) : (
          <div key={t.id} className="grid grid-cols-[64px_1fr] gap-3 text-sm">
            <span className={`label-caps pt-0.5 ${t.who === "user" ? "text-amber" : "text-teal"}`}>{t.who === "user" ? "Query" : "Jarvis"}</span>
            <div className="min-w-0">
              <p className={`whitespace-pre-wrap break-words ${t.who === "user" ? "italic text-ink" : "text-ink"}`}>{t.text}</p>
              {t.meta && <p className="mt-1 font-mono text-[11px] text-ink-3">{t.meta}</p>}
            </div>
          </div>
        ),
      )}
      <div ref={end} />
    </div>
  );
}

export function CommandInput({ role, placeholder = "Type a command for the dispatcher…", autoFocus }: { role?: AgentRole; placeholder?: string; autoFocus?: boolean }) {
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
        void handleInput(t, { channel: "text", role });
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
