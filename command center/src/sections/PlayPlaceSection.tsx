import { useEffect, useState } from "react";
import { Archive, BookMarked, Code2, Eye, Hammer, Loader2, Maximize2, Play, Send, Sparkles, Trash2, Wand2 } from "lucide-react";
import { Card, Empty } from "@/components/ui";
import { useCollection } from "@/lib/cc-api";
import { gateway } from "@/lib/gateway";
import { cmd, isTauri, type Idea, type PlayCard } from "@/lib/platform";
import { useSettings } from "@/stores/settings";
import { runPipeline, usePipelines } from "@/features/os/pipeline-store";
import { useFocus } from "@/features/os/focus-store";
import { useOsName } from "@/features/os/os-store";
import { useToasts } from "@/features/reminders/notify";

/**
 * The Play Place: prototypes the Designer / Coder pipeline staged, rendered in
 * a sandboxed iframe (opaque origin — it can't touch the OS or your files),
 * plus the Ideas & Tasks Ledger they came from.
 */
export function PlayPlaceSection() {
  const clearUnseen = usePipelines((s) => s.clearUnseen);
  useEffect(() => clearUnseen(), [clearUnseen]);
  return (
    <div className="mx-auto h-full w-full max-w-7xl space-y-4 overflow-y-auto px-4 pb-32 md:px-6 md:pb-8">
      <PipelineBars />
      <div className="grid gap-4 xl:grid-cols-[1fr_380px]">
        <PlayCards />
        <IdeasLedger />
      </div>
    </div>
  );
}

/** Live progress of pipelines in flight. */
export function PipelineBars() {
  const runs = Object.values(usePipelines((s) => s.runs));
  if (!runs.length) return null;
  return (
    <Card title="Pipelines running">
      <ul className="space-y-2">
        {runs.map((r) => (
          <li key={r.id}>
            <div className="mb-1 flex items-center gap-2 text-xs">
              <Loader2 size={12} className={r.pct < 100 ? "animate-spin text-amber-soft" : "text-teal"} />
              <span className="text-ink">{r.title || "Prototype"}</span>
              <span className="font-mono text-ink-3">{r.stage} · {r.label}</span>
              <span className="ml-auto font-mono text-ink-2">{r.pct}%</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-white/10">
              <div className="h-full rounded-full bg-gradient-to-r from-amber to-teal transition-[width] duration-500" style={{ width: `${r.pct}%` }} />
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

const queue = (kind: string, payload: Record<string, unknown>) => gateway("/api/os/inbox", { method: "POST", body: JSON.stringify({ kind, payload }) });

export function PlayCards({ compact = false }: { compact?: boolean }) {
  const { items, loaded, update, remove } = useCollection<PlayCard>("playplace");
  const focus = useFocus((s) => s.card);
  const cards = items.filter((c) => c.status !== "archived").sort((a, b) => (b._updated ?? 0) - (a._updated ?? 0));
  if (!loaded) return <Card title="Play Place">Loading…</Card>;
  if (!cards.length)
    return (
      <Card title="Play Place">
        <Empty>Nothing staged yet. Tell {"Tony"} an idea (“I’ve been thinking about building…”) and say “yeah, build that” — the prototype lands here.</Empty>
      </Card>
    );
  return (
    <div className="space-y-4">
      {cards.map((c) => (
        <PlayCardView key={c.id} card={c} compact={compact} focused={focus === c.id} onArchive={() => void update(c.id, { status: "archived" })} onDiscard={() => void remove(c.id)} />
      ))}
    </div>
  );
}

function PlayCardView({ card, compact, focused, onArchive, onDiscard }: { card: PlayCard; compact: boolean; focused: boolean; onArchive: () => void; onDiscard: () => void }) {
  const gw = useSettings((s) => s.gatewayUrl).replace(/\/+$/, "");
  const [code, setCode] = useState(false);
  const [tweak, setTweak] = useState("");
  const [target, setTarget] = useState<"designer" | "coder">("coder");
  const [busy, setBusy] = useState<string | null>(null);
  const [full, setFull] = useState(false);
  const desktop = isTauri();
  const src = `${gw}/api/play-place/${card.id}/preview?v=${Math.round(card._updated ?? 0)}`;

  const act = async (label: string, desktopRun: () => Promise<unknown>, phonePayload: Record<string, unknown>) => {
    setBusy(label);
    try {
      if (desktop) await desktopRun();
      else {
        await queue("playplace", { cardId: card.id, ...phonePayload });
        useToasts.getState().push({ title: "Sent to the desktop", body: `${label} is running on MORTADELLA.`, tone: "info" });
      }
    } catch (e) {
      useToasts.getState().push({ title: label, body: String(e), tone: "error" });
    } finally {
      setBusy(null);
    }
  };

  const statusTone = card.status === "approved" ? "text-teal" : card.status === "committed" ? "text-volt" : card.status === "building" ? "text-amber-soft" : "text-ink-2";
  return (
    <section className={`glass rounded-[20px] p-4 ${focused ? "ring-2 ring-amber/60" : ""}`}>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Sparkles size={15} className="text-amber-soft" />
        <h2 className="text-[15px] font-semibold text-ink">{card.title}</h2>
        <span className={`label-caps ${statusTone}`}>{card.status}</span>
        {card.versions && <span className="font-mono text-[11px] text-ink-3">v{card.versions.length}</span>}
        <div className="ml-auto flex gap-1">
          <button onClick={() => setCode((v) => !v)} className="pill-glass !h-8 !px-2.5 text-xs" aria-pressed={code} title="Code inspector">
            {code ? <Eye size={13} /> : <Code2 size={13} />} {code ? "Preview" : "Code"}
          </button>
          <button onClick={() => setFull(true)} className="pill-glass !h-8 !w-8 !p-0" title="Full screen" aria-label="Full screen preview">
            <Maximize2 size={13} />
          </button>
        </div>
      </div>
      {card.idea && !compact && <p className="mb-2 line-clamp-2 text-xs text-ink-3">{card.idea}</p>}

      {code ? (
        <pre className="well max-h-[420px] overflow-auto whitespace-pre-wrap rounded-[12px] p-3 font-mono text-[11px] text-ink-2">{card.html || "(no HTML)"}</pre>
      ) : (
        <iframe
          key={src}
          src={src}
          title={`Prototype: ${card.title}`}
          // No allow-same-origin: the prototype runs in an opaque origin, isolated from the OS.
          sandbox="allow-scripts allow-forms allow-modals allow-popups"
          className={`w-full rounded-[12px] border border-white/10 bg-white ${compact ? "h-[340px]" : "h-[480px]"}`}
          loading="lazy"
        />
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          disabled={!!busy}
          onClick={() => void act("Approve & Build", () => cmd("playplace_approve", { cardId: card.id }), { action: "approve" })}
          className="pill-primary !h-9 text-xs"
          title="Lock the concept → Prompter writes build instructions → Coder"
        >
          {busy === "Approve & Build" ? <Loader2 size={13} className="animate-spin" /> : <Hammer size={13} />} Approve & Build
        </button>
        <button
          disabled={!!busy}
          onClick={() => void act("Commit to Librarian Vault", () => cmd("playplace_commit", { cardId: card.id }), { action: "commit" })}
          className="pill-glass !h-9 text-xs"
          title="Spec, prompt chain and code → C:\ai-hub\memory + the Librarian's RAG"
        >
          {busy === "Commit to Librarian Vault" ? <Loader2 size={13} className="animate-spin" /> : <BookMarked size={13} />} Commit to Vault
        </button>
        <button onClick={onArchive} className="pill-glass !h-9 text-xs" title="Hide from the Play Place (kept in the vault)">
          <Archive size={13} /> Archive
        </button>
        <button onClick={() => confirm(`Discard “${card.title}”? This deletes the staged prototype.`) && onDiscard()} className="pill-glass !h-9 text-xs hover:!border-alert/50" title="Delete this staging artifact">
          <Trash2 size={13} /> Discard
        </button>
      </div>

      <form
        className="mt-2 flex gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          const notes = tweak.trim();
          if (!notes) return;
          setTweak("");
          void act("Iterate", () => cmd("playplace_iterate", { cardId: card.id, notes, target }), { action: "iterate", notes, target });
        }}
      >
        <select value={target} onChange={(e) => setTarget(e.target.value as "designer" | "coder")} className="field !h-9 !w-auto !py-1 text-xs" aria-label="Send tweak to">
          <option value="coder">Coder</option>
          <option value="designer">Designer</option>
        </select>
        <input value={tweak} onChange={(e) => setTweak(e.target.value)} placeholder="Iterate / tweak — e.g. “bigger CTA, add a dark calendar view”" className="field !h-9 min-w-0 flex-1 !py-1 text-xs" />
        <button className="pill-glass !h-9 text-xs" disabled={!tweak.trim() || !!busy}>
          {busy === "Iterate" ? <Loader2 size={13} className="animate-spin" /> : <Wand2 size={13} />} Tweak
        </button>
      </form>

      {card.buildPlan && !compact && (
        <details className="mt-3">
          <summary className="cursor-pointer text-xs text-teal">Build plan (Prompter → Coder)</summary>
          <pre className="well mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded-[10px] p-2 text-[11px] text-ink-2">{card.buildPlan}</pre>
        </details>
      )}
      {card.vaultPath && <p className="mt-2 font-mono text-[11px] text-ink-3">Vault: {card.vaultPath}</p>}

      {full && (
        <div className="fixed inset-0 z-[85] flex flex-col bg-black/80 p-3" role="dialog" aria-modal="true" aria-label={`${card.title} full screen`}>
          <div className="mb-2 flex items-center">
            <span className="text-sm text-ink">{card.title}</span>
            <button onClick={() => setFull(false)} className="pill-glass ml-auto !h-8 text-xs">
              Close
            </button>
          </div>
          <iframe src={src} title={`Prototype full screen: ${card.title}`} sandbox="allow-scripts allow-forms allow-modals allow-popups" className="w-full flex-1 rounded-[12px] border-0 bg-white" />
        </div>
      )}
    </section>
  );
}

/** Ideas & Tasks Ledger (Tony → Prompter → Librarian). */
export function IdeasLedger({ compact = false }: { compact?: boolean }) {
  const { items, update } = useCollection<Idea>("ideas");
  const name = useOsName();
  const running = usePipelines((s) => s.runs);
  const ideas = items.filter((i) => i.status !== "archived").sort((a, b) => (b._updated ?? 0) - (a._updated ?? 0));
  return (
    <Card title="Ideas & tasks ledger" hint={compact ? undefined : `Every idea you tell ${name} is broken down by the Prompter and saved here by the Librarian (also in C:\\ai-hub\\memory\\ideas).`}>
      {!ideas.length && <Empty>No ideas yet.</Empty>}
      <ul className="space-y-2">
        {ideas.map((i) => {
          const done = i.tasks?.filter((t) => t.done).length ?? 0;
          const live = !!running[i.id];
          return (
            <li key={i.id} className="rounded-[12px] border border-white/[0.06] bg-white/[0.02] p-3">
              <div className="flex items-center gap-2">
                <span className="text-sm text-ink">{i.title}</span>
                <span className="label-caps text-ink-3">{i.status}</span>
                <span className="ml-auto font-mono text-[11px] text-ink-3">
                  {done}/{i.tasks?.length ?? 0}
                </span>
              </div>
              {i.summary && !compact && <p className="mt-1 text-xs text-ink-2">{i.summary}</p>}
              {!compact && (
                <ul className="mt-2 space-y-1">
                  {(i.tasks ?? []).map((t) => (
                    <li key={t.id}>
                      <label className="flex items-start gap-2 text-xs text-ink-2">
                        <input type="checkbox" checked={t.done} onChange={() => void update(i.id, { tasks: i.tasks.map((x) => (x.id === t.id ? { ...x, done: !x.done } : x)) })} className="mt-0.5 accent-teal" />
                        <span className={t.done ? "line-through opacity-60" : ""}>{t.text}</span>
                      </label>
                    </li>
                  ))}
                </ul>
              )}
              <div className="mt-2 flex flex-wrap gap-1.5">
                {(i.status === "captured" || i.status === "staged") && (
                  <button disabled={live} onClick={() => void runPipeline(i.id, i.title, "general")} className="pill-primary !h-7 !px-3 text-[11px]">
                    {live ? <Loader2 size={11} className="animate-spin" /> : <Play size={11} />} {i.status === "staged" ? "Rebuild prototype" : "Run pipeline"}
                  </button>
                )}
                {i.cardId && (
                  <button onClick={() => useFocus.getState().set({ card: i.cardId! })} className="pill-glass !h-7 !px-3 text-[11px]">
                    <Send size={11} /> Prototype
                  </button>
                )}
                <button onClick={() => void update(i.id, { status: "archived" })} className="pill-glass !h-7 !px-3 text-[11px]">
                  <Archive size={11} /> Archive
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
