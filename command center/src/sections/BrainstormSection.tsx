import { useMemo, useState } from "react";
import { BellPlus, Loader2, Mic, Plus, Search, Sparkles, Square, Trash2 } from "lucide-react";
import { Card, Input } from "@/components/ui";
import { collections, useCollection, type Item } from "@/lib/cc-api";
import { useBrainstorm, type BrainstormNote } from "@/features/brainstorm/capture";
import { VoiceOrb } from "@/features/voice/VoiceOrb";
import { parseWhen } from "@/features/reminders/when";
import type { Reminder } from "@/features/reminders/types";
import { useSettings, type ListenProfile } from "@/stores/settings";

const LISTEN_PROFILE_OPTIONS: { id: ListenProfile; label: string }[] = [
  { id: "snappy", label: "Snappy 1s" },
  { id: "relaxed", label: "Relaxed 3s" },
  { id: "continuous", label: "Continuous (push-to-talk)" },
];

/**
 * Brainstorming Mode: a continuous voice scratchpad. Raw transcript is always
 * kept; the local LLM adds structure on top. Notes live in the shared store, so
 * a brain-dump on the phone appears here within seconds (and vice versa).
 */
export function BrainstormSection() {
  const { items, remove, update, error } = useCollection<BrainstormNote>("notes");
  const cap = useBrainstorm();
  const [selected, setSelected] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const brainstorm = useSettings((s) => s.brainstorm);
  const { autoOrganizeEvery: every, listenProfile: profile } = brainstorm;
  const setSettings = useSettings((s) => s.set);

  const notes = useMemo(
    () => items.filter((n) => !q || `${n.title} ${n.rawText} ${(n.organized?.tags ?? []).join(" ")}`.toLowerCase().includes(q.toLowerCase())),
    [items, q],
  );
  const activeId = cap.noteId && cap.listening ? cap.noteId : (selected ?? notes[0]?.id ?? null);
  const note = items.find((n) => n.id === activeId) ?? null;

  return (
    <div className="mx-auto grid h-full w-full max-w-6xl gap-4 overflow-y-auto px-4 pb-32 md:grid-cols-[280px_1fr] md:overflow-hidden md:px-6 md:pb-6">
      <aside className="glass flex min-h-0 flex-col rounded-[20px] p-3 md:h-full">
        <div className="mb-2 flex gap-2">
          <div className="relative flex-1">
            <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-3" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search ideas" className="!h-9 !py-1 !pl-8 text-[13px]" aria-label="Search notes" />
          </div>
          <button
            aria-label="New brainstorm"
            title="New brainstorm"
            onClick={async () => {
              const n = await collections.create<BrainstormNote>("notes", { title: "Untitled brainstorm", rawText: "", segments: [] });
              setSelected(n.id);
            }}
            className="pill-glass !h-9 !w-9 shrink-0 !p-0"
          >
            <Plus size={15} />
          </button>
        </div>
        {error && <p className="mb-2 text-[11px] text-alert">Gateway: {error}</p>}
        <ul className="min-h-0 flex-1 space-y-1 overflow-y-auto">
          {notes.map((n) => (
            <li key={n.id}>
              <button
                onClick={() => setSelected(n.id)}
                className={`w-full rounded-[12px] px-3 py-2 text-left ${n.id === activeId ? "bg-amber/12 border border-amber/40" : "border border-transparent hover:bg-white/5"}`}
              >
                <p className="truncate text-[13px] text-ink">{n.title}</p>
                <p className="truncate font-mono text-[10.5px] text-ink-3">
                  {new Date(n._updated * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} · {n.segments?.length ?? 0} segments
                  {n.organized ? " · organized" : ""}
                </p>
              </button>
            </li>
          ))}
          {!notes.length && <li className="px-2 py-6 text-center text-xs text-ink-3">No ideas yet. Hit Listen and think out loud.</li>}
        </ul>
      </aside>

      <section className="flex min-h-0 flex-col gap-4 md:overflow-y-auto">
        <Card>
          <div className="flex flex-wrap items-center gap-4">
            <button
              onClick={() => (cap.listening ? void cap.stop() : void cap.start(note && !cap.listening && selected ? note.id : undefined))}
              aria-pressed={cap.listening}
              className={`relative grid size-20 shrink-0 place-items-center rounded-full ${cap.listening ? "" : "border border-white/10"}`}
              aria-label={cap.listening ? "Stop brainstorm listening" : "Start brainstorm listening"}
            >
              <VoiceOrb state={cap.listening ? (cap.phase === "transcribing" ? "transcribing" : "listening") : "idle"} size={72} />
              <span className="absolute inset-0 grid place-items-center text-ink">{cap.listening ? <Square size={18} fill="currentColor" /> : <Mic size={22} />}</span>
            </button>
            <div className="min-w-0 flex-1">
              <p className="font-medium text-ink">{cap.listening ? "Brainstorm Listen Mode — on" : "Brainstorm Listen Mode"}</p>
              <p className="text-sm text-ink-2">
                {cap.listening
                  ? cap.phase === "transcribing"
                    ? "Transcribing that thought…"
                    : cap.phase === "speech"
                      ? "Hearing you…"
                      : profile === "continuous"
                        ? "Recording until you press Stop."
                        : profile === "snappy"
                          ? "Listening. A short pause ends each thought."
                          : "Listening. Pause between thoughts; each one is saved as you go."
                  : "Think out loud. Nothing is sent as a command — it's just captured, then organized."}
              </p>
              {cap.error && <p className="mt-1 text-xs text-alert">{cap.error}</p>}
            </div>
            <label className="flex items-center gap-2 text-xs text-ink-2">
              Organize every
              <input type="number" min={0} max={50} value={every} onChange={(e) => setSettings({ brainstorm: { ...brainstorm, autoOrganizeEvery: Number(e.target.value) } })} className="field !h-8 !w-16 !py-1 font-mono text-[12px]" aria-label="Auto-organize every N segments" />
              thoughts
            </label>
          </div>
          <div className="mt-3 flex flex-wrap gap-2" role="tablist" aria-label="Dictation profile">
            {LISTEN_PROFILE_OPTIONS.map(({ id, label }) => (
              <button
                key={id}
                role="tab"
                aria-selected={profile === id}
                onClick={() => {
                  if (profile === id) return;
                  setSettings({ brainstorm: { ...brainstorm, listenProfile: id } });
                  // Changing it mid-listen restarts the loop so the new pause/cap applies right away.
                  if (cap.listening) cap.restartProfile();
                }}
                className={`flex h-8 items-center rounded-full border px-3 text-[12px] transition-colors ${
                  profile === id ? "border-amber/60 bg-amber/15 text-ink" : "border-white/10 bg-[rgba(11,13,17,0.45)] text-ink-2 backdrop-blur-md hover:text-ink"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </Card>

        {note ? <NoteView note={note} onDelete={() => void remove(note.id).then(() => setSelected(null))} onRename={(title) => void update(note.id, { title, titleLocked: true })} /> : null}
      </section>
    </div>
  );
}

function NoteView({ note, onDelete, onRename }: { note: Item<BrainstormNote>; onDelete: () => void; onRename: (t: string) => void }) {
  const cap = useBrainstorm();
  const [add, setAdd] = useState("");
  const [done, setDone] = useState<Set<number>>(new Set());
  const o = note.organized;

  const addText = async () => {
    const text = add.trim();
    if (!text) return;
    const segments = [...(note.segments ?? []), { t: Date.now(), text, device: "typed" }];
    await collections.update<BrainstormNote>("notes", note.id, { segments, rawText: segments.map((s) => s.text).join("\n") });
    setAdd("");
  };

  const toReminder = async (i: number, text: string, due?: string | null) => {
    const when = due ? parseWhen(due) ?? parseWhen(`on ${due}`) : null;
    await collections.create<Reminder>("reminders", { title: text, kind: "reminder", dueAt: when?.at.getTime() ?? Date.now() + 86_400_000, repeat: "none", source: "local" });
    setDone(new Set(done).add(i));
  };

  return (
    <>
      <Card
        action={
          <div className="flex gap-2">
            <button onClick={() => void cap.organize(note.id)} disabled={cap.organizing || !note.rawText} className="pill-primary !h-8 text-xs">
              {cap.organizing ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />} Organize
            </button>
            <button onClick={onDelete} aria-label="Delete note" className="pill-glass !h-8 !w-8 !p-0 hover:!border-alert/50">
              <Trash2 size={13} />
            </button>
          </div>
        }
      >
        <input
          key={note.id}
          defaultValue={note.title}
          onBlur={(e) => e.target.value !== note.title && onRename(e.target.value)}
          className="w-full bg-transparent text-xl font-semibold text-ink outline-none focus:ring-0"
          aria-label="Note title"
        />
        {o?.summary && <p className="mt-2 text-[15px] leading-relaxed text-ink-2">{o.summary}</p>}
        {!!o?.tags?.length && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {o.tags.map((t) => (
              <span key={t} className="rounded-full border border-teal/40 px-2 py-0.5 font-mono text-[11px] text-teal">
                #{t}
              </span>
            ))}
          </div>
        )}
      </Card>

      {o && (
        <div className="grid gap-4 lg:grid-cols-2">
          {(o.categories ?? []).map((c) => (
            <Card key={c.name} title={c.name}>
              <ul className="list-disc space-y-1.5 pl-5 text-sm text-ink">
                {c.bullets.map((b, i) => (
                  <li key={i}>{b}</li>
                ))}
              </ul>
            </Card>
          ))}
          {!!o.actions?.length && (
            <Card title="Action items">
              <ul className="space-y-2">
                {o.actions.map((a, i) => (
                  <li key={i} className="flex items-start gap-2 text-sm">
                    <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-amber" />
                    <span className="flex-1 text-ink">
                      {a.text}
                      {a.due && <span className="ml-1 font-mono text-[11px] text-ink-3">({a.due})</span>}
                    </span>
                    <button onClick={() => void toReminder(i, a.text, a.due)} disabled={done.has(i)} className="pill-glass !h-7 shrink-0 !px-2 text-[11px]" title="Turn into a reminder">
                      <BellPlus size={12} /> {done.has(i) ? "Added" : "Remind"}
                    </button>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      )}

      <Card title="Raw transcript" hint="Always kept exactly as captured. Organizing never overwrites it.">
        <div className="max-h-80 space-y-2 overflow-y-auto">
          {(note.segments ?? []).map((s, i) => (
            <p key={i} className="text-sm leading-relaxed text-ink">
              <span className="mr-2 font-mono text-[10.5px] text-ink-3">
                {new Date(s.t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} · {s.device}
              </span>
              {s.text}
            </p>
          ))}
          {!note.segments?.length && <p className="text-sm text-ink-3">Nothing captured yet.</p>}
        </div>
        <form
          className="mt-3 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void addText();
          }}
        >
          <Input value={add} onChange={(e) => setAdd(e.target.value)} placeholder="Or type a thought…" className="!h-9 !py-1 text-[13px]" aria-label="Add a thought" />
          <button className="pill-glass !h-9 shrink-0 text-xs" disabled={!add.trim()}>
            Add
          </button>
        </form>
      </Card>
    </>
  );
}
