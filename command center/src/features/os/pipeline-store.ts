import { create } from "zustand";
import { cmd, isTauri, onNativeEvent, type PipelineFailed, type PipelineStepEvent } from "@/lib/platform";
import { gateway } from "@/lib/gateway";
import { useVoice, THREADS, type ThreadId } from "@/features/voice/voice-store";
import { useToasts } from "@/features/reminders/notify";
import { osName } from "./os-store";

/**
 * Idea-to-Execution pipelines in flight (desktop: from `pipeline-step` events;
 * phone: polled from the gateway). Every agent-to-agent step is logged as a
 * relay turn in the matching Dispatcher tab.
 */
export interface PipelineRun {
  id: string;
  ideaId: string | null;
  title: string;
  stage: string;
  pct: number;
  label: string;
  cardId?: string;
  at: number;
}

interface PipelineStore {
  runs: Record<string, PipelineRun>;
  /** New prototypes not yet opened in the Play Place (nav badge). */
  unseen: number;
  /** Idea waiting for "yes, build it" (per thread). */
  offered: { ideaId: string; title: string; thread: ThreadId } | null;
  setOffered: (o: PipelineStore["offered"]) => void;
  clearUnseen: () => void;
}

export const usePipelines = create<PipelineStore>((set) => ({
  runs: {},
  unseen: 0,
  offered: null,
  setOffered: (offered) => set({ offered }),
  clearUnseen: () => set({ unseen: 0 }),
}));

/** Remember which tab started a pipeline, so the "it's live" message lands there. */
const origin = new Map<string, ThreadId>();

export async function runPipeline(ideaId: string, title: string, thread: ThreadId) {
  usePipelines.getState().setOffered(null);
  origin.set(ideaId, thread);
  useVoice.getState().pushTurn({ who: "system", text: `Pipeline started for “${title}”: Prompter → Designer → Coder → Play Place.`, tone: "ok", thread });
  usePipelines.setState((s) => ({ runs: { ...s.runs, [ideaId]: { id: ideaId, ideaId, title, stage: "starting", pct: 2, label: "Prompter", at: Date.now() } } }));
  if (!isTauri()) {
    // Phone: the desktop runs it from the queue.
    await gateway("/api/os/inbox", { method: "POST", body: JSON.stringify({ kind: "pipeline", payload: { ideaId } }) });
    return;
  }
  try {
    await cmd("idea_pipeline_run", { ideaId });
  } catch (e) {
    useVoice.getState().pushTurn({ who: "system", text: `Pipeline failed: ${e instanceof Error ? e.message : String(e)}`, tone: "error", thread });
    usePipelines.setState((s) => {
      const r = { ...s.runs };
      delete r[ideaId];
      return { runs: r };
    });
  }
}

function onStep(e: PipelineStepEvent) {
  const thread = (THREADS.includes(e.thread as ThreadId) ? e.thread : "auto") as ThreadId;
  const key = e.ideaId ?? e.pipelineId;
  if (e.kind === "verify") {
    useVoice.getState().pushTurn({ who: "system", text: e.text, tone: e.ok ? "ok" : "warn", thread });
    return;
  }
  if (e.stage === "done") {
    const back = (e.ideaId && origin.get(e.ideaId)) || "general";
    useVoice.getState().pushTurn({ who: "agent", from: "os", text: e.text, thread: back, cardId: e.cardId ?? undefined });
    if (back !== "general") useVoice.getState().pushTurn({ who: "agent", from: "os", text: e.text, thread: "general", cardId: e.cardId ?? undefined });
    useToasts.getState().push({ title: `${osName()} · Play Place`, body: e.text, tone: "info" });
    usePipelines.setState((s) => ({ unseen: s.unseen + 1 }));
  } else {
    useVoice.getState().pushTurn({ who: "relay", from: e.from, to: e.to, text: e.text, tone: e.ok ? undefined : "warn", meta: `${e.stage}${e.ms ? ` · ${(e.ms / 1000).toFixed(1)}s` : ""}`, thread, cardId: e.cardId ?? undefined });
  }
  if (e.pct > 0) {
    usePipelines.setState((s) => {
      const prev = s.runs[key];
      const run: PipelineRun = { id: key, ideaId: e.ideaId, title: prev?.title ?? "", stage: e.stage, pct: e.pct, label: `${e.from} → ${e.to}`, cardId: e.cardId ?? prev?.cardId, at: Date.now() };
      const runs = { ...s.runs, [key]: run };
      if (e.pct >= 100) setTimeout(() => usePipelines.setState((x) => { const r = { ...x.runs }; delete r[key]; return { runs: r }; }), 60_000);
      return { runs };
    });
  }
}

let started = false;
/** Desktop: listen to Rust. Phone: poll the gateway's progress feed. */
export function startPipelineFeed() {
  if (started) return;
  started = true;
  if (isTauri()) {
    void onNativeEvent<PipelineStepEvent>("pipeline-step", onStep);
    // A step failed → rolled back to its checkpoint; offer Retry / Offload in Tony's chat.
    void onNativeEvent<PipelineFailed>("pipeline-failed", (f) => {
      const thread = origin.get(f.ideaId) ?? "general";
      const cp = f.checkpoint ?? "";
      useVoice.getState().pushTurn({
        who: "agent",
        from: "os",
        thread,
        text: `The ${f.stage} step for “${f.title}” failed (${f.error.slice(0, 160)}). I rolled back to the last checkpoint — retry it, or hand that step to a CLI agent?`,
        actions: cp
          ? [
              { label: "Retry step", run: `retry:${cp}` },
              { label: "Offload to Claude CLI", run: `offload:claude-cli:${cp}` },
              { label: "Offload to Gemini CLI", run: `offload:gemini-cli:${cp}` },
            ]
          : undefined,
      });
      usePipelines.setState((s) => {
        const runs = { ...s.runs };
        delete runs[f.ideaId];
        return { runs };
      });
    });
    return;
  }
  setInterval(() => {
    void gateway<{ items: { ideaId: string; pipelineId: string; stage: string; pct: number; label: string }[] }>("/api/pipeline/progress")
      .then((r) =>
        usePipelines.setState((s) => {
          const runs: Record<string, PipelineRun> = {};
          for (const p of r.items) runs[p.ideaId] = { id: p.ideaId, ideaId: p.ideaId, title: s.runs[p.ideaId]?.title ?? "", stage: p.stage, pct: p.pct, label: p.label, at: Date.now() };
          return { runs };
        }),
      )
      .catch(() => undefined);
  }, 5000);
}
