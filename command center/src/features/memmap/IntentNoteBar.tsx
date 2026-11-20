import { useEffect, useRef, useState } from "react";
import { Loader2, Mic, Send, Square } from "lucide-react";
import { isTauri, type DevTaskKind } from "@/lib/platform";
import { useToasts } from "@/features/reminders/notify";
import { voiceCaps } from "@/features/voice/voice-controller";
import { currentUi, useDevQueue } from "./dev-queue";
import { useDictation } from "./dictation";
import { splitNote } from "./format";
import { Panel } from "./parts";

const KINDS: { id: DevTaskKind; label: string; hint: string }[] = [
  { id: "task", label: "Task", hint: "Something to build or change" },
  { id: "note", label: "Note", hint: "A runtime observation for the next session's brief" },
  { id: "fix", label: "Fix", hint: "Something broken" },
];

/**
 * INTENT & RUNTIME NOTE: type (or dictate) a note and Dispatch it to the dev task queue.
 * Dispatch only logs it — nothing goes to Tony or any agent (decision §6.4). The mic is a
 * private dictation channel into this box (see dictation.ts), never a command to Tony.
 * Ctrl/⌘+Enter dispatches.
 */
export function IntentNoteBar({ className = "" }: { className?: string }) {
  const [text, setText] = useState("");
  const [kind, setKind] = useState<DevTaskKind>("task");
  const [dictated, setDictated] = useState(false);
  const [busy, setBusy] = useState(false);
  const add = useDevQueue((s) => s.add);
  const { phase, error, toggle, hardStop } = useDictation();
  const box = useRef<HTMLTextAreaElement>(null);
  const desktop = isTauri();

  // Leaving the page releases the mic and discards a half-captured note.
  useEffect(() => () => useDictation.getState().hardStop(), []);

  const { title } = splitNote(text);
  const canSend = desktop && !!title && !busy;

  const dispatch = async () => {
    if (!canSend) return;
    hardStop();
    const { title, body } = splitNote(text);
    setBusy(true);
    try {
      const t = await add({ title, body: body || undefined, kind, source: dictated ? "voice" : "typed", ui: currentUi({ sttEngine: voiceCaps.sttName, ttsEngine: voiceCaps.ttsName }) });
      setText("");
      setDictated(false);
      useToasts.getState().push({ title: `Logged to the dev queue`, body: `${t.title} · ${t.category} · P${t.priority}`, tone: "info" });
    } catch (e) {
      useToasts.getState().push({ title: "Couldn't log that", body: e instanceof Error ? e.message : String(e), tone: "error" });
    } finally {
      setBusy(false);
    }
  };

  const onMic = () =>
    toggle((said) => {
      setText((t) => (t.trim() ? `${t.replace(/\s+$/, "")} ${said}` : said));
      setDictated(true);
      box.current?.focus();
    });

  const listening = phase === "waiting" || phase === "speech";
  const micTitle =
    phase === "idle"
      ? "Dictate into this box (stays here — never sent to Tony)"
      : phase === "transcribing"
        ? "Transcribing… tap to discard"
        : phase === "speech"
          ? "Listening — tap to finish"
          : "Waiting for speech — tap to cancel";

  return (
    <Panel
      title="Intent & runtime note"
      className={`shrink-0 ${className}`}
      action={
        <div role="radiogroup" aria-label="Kind" className="flex gap-0.5">
          {KINDS.map((k) => (
            <button
              key={k.id}
              type="button"
              role="radio"
              aria-checked={kind === k.id}
              title={k.hint}
              onClick={() => setKind(k.id)}
              className={`label-caps rounded-full px-1.5 py-0.5 !text-[9px] transition-colors ${kind === k.id ? "bg-holo/15 text-holo" : "text-ink-3 hover:text-ink-2"}`}
            >
              {k.label}
            </button>
          ))}
        </div>
      }
    >
      <textarea
        ref={box}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            void dispatch();
          }
        }}
        rows={3}
        maxLength={8000}
        disabled={!desktop}
        placeholder={desktop ? "What did you notice, or what should change? First line becomes the title." : "The dev queue lives in the desktop app."}
        className="w-full resize-none rounded-[10px] border border-holo/15 bg-black/30 px-2.5 py-2 font-mono text-[11.5px] leading-relaxed text-ink outline-none placeholder:text-ink-3 focus:border-holo/40"
      />
      {error && phase === "idle" && <p className="mt-1 font-mono text-[10px] text-ember">{error}</p>}
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          onClick={onMic}
          disabled={!desktop}
          aria-pressed={phase !== "idle"}
          title={micTitle}
          aria-label={micTitle}
          className={`grid size-9 shrink-0 place-items-center rounded-full border transition-colors disabled:opacity-40 ${
            phase === "idle" ? "border-holo/25 text-ink-2 hover:text-holo" : "border-ember/60 bg-ember/15 text-ember"
          }`}
        >
          {phase === "transcribing" ? <Loader2 size={15} className="animate-spin" /> : listening ? <Square size={13} /> : <Mic size={15} />}
        </button>
        <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-ink-3">
          {phase === "speech" ? "listening…" : phase === "waiting" ? "say your note" : phase === "transcribing" ? "transcribing…" : dictated ? "dictated · logs as voice" : "logs to the queue only"}
        </span>
        <button
          type="button"
          onClick={() => void dispatch()}
          disabled={!canSend}
          title={desktop ? "Log to the dev task queue (Ctrl+Enter). Tony isn't messaged." : "Desktop app only"}
          className="flex h-9 items-center gap-1.5 rounded-full border border-holo/50 bg-holo/15 px-4 font-mono text-[11px] font-semibold uppercase tracking-wider text-holo shadow-[0_0_16px_-4px_rgba(0,210,255,0.6)] transition-[filter,transform] hover:brightness-125 active:scale-[0.97] disabled:opacity-40 disabled:shadow-none"
        >
          {busy ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />} Dispatch
        </button>
      </div>
    </Panel>
  );
}
