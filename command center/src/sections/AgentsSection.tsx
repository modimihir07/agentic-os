import { lazy, Suspense, useState } from "react";
import { Library, Loader2, Trash2, X } from "lucide-react";
import { isTauri } from "@/lib/platform";
import { SUB_AGENTS, type AgentRole } from "@/features/dispatcher/agents";
import { THREADS, useVoice, type ThreadId } from "@/features/voice/voice-store";
import { CommandInput, MicButton, Transcript } from "@/features/voice/VoiceParts";
import { useOsName } from "@/features/os/os-store";

/**
 * The Dispatcher. Each tab is its own isolated thread: Auto-route, every
 * sub-agent, and the OS itself. Talking on a sub-agent's tab goes straight to
 * that agent's AnythingLLM workspace; asking the OS to "ask my booking agent…"
 * from Auto-route shows the TONY ⇄ BOOKING AGENT exchange in the Booking tab.
 */
const McpRegistryCard = lazy(() => import("@/sections/settings/LibrarySettings").then((m) => ({ default: m.McpRegistryCard })));
const SkillsLibraryCard = lazy(() => import("@/sections/settings/LibrarySettings").then((m) => ({ default: m.SkillsLibraryCard })));

export function AgentsSection() {
  const [drawer, setDrawer] = useState(false);
  const thread = useVoice((s) => s.activeThread);
  const setThread = useVoice((s) => s.setActiveThread);
  const state = useVoice((s) => s.state);
  const counts = useVoice((s) => THREADS.map((t) => s.turns.filter((x) => x.thread === t && x.who !== "system").length).join(","));
  const clear = useVoice((s) => s.clear);
  const name = useOsName();
  const n = Object.fromEntries(THREADS.map((t, i) => [t, Number(counts.split(",")[i])])) as Record<ThreadId, number>;
  const label = (t: ThreadId) => (t === "auto" ? "Auto-route" : t === "general" ? name : SUB_AGENTS[t as AgentRole].label);

  return (
    <div className="mx-auto flex h-full w-full max-w-4xl flex-col px-4 pb-28 md:px-6 md:pb-6">
      <div className="mb-3 flex flex-wrap gap-2" role="tablist" aria-label="Conversation threads">
        {THREADS.map((t) => {
          const Icon = t === "auto" ? null : SUB_AGENTS[t as AgentRole].icon;
          return (
            <button
              key={t}
              role="tab"
              aria-selected={thread === t}
              onClick={() => setThread(t)}
              className={`flex h-9 items-center gap-2 rounded-full border px-3.5 text-[13px] transition-colors ${
                thread === t ? "border-amber/60 bg-amber/15 text-ink" : "border-white/10 bg-[rgba(11,13,17,0.45)] text-ink-2 backdrop-blur-md hover:text-ink"
              }`}
            >
              {Icon && <Icon size={14} />}
              {label(t)}
              {n[t] > 0 && <span className="rounded-full bg-white/10 px-1.5 font-mono text-[10px] text-ink-2">{n[t]}</span>}
            </button>
          );
        })}
        {isTauri() && (
          <button onClick={() => setDrawer(true)} className="ml-auto flex h-9 items-center gap-1.5 rounded-full border border-white/10 px-3 text-[13px] text-ink-2 hover:text-ink" title="Skills & MCP library">
            <Library size={13} /> Skills & MCP
          </button>
        )}
        {n[thread] > 0 && (
          <button onClick={() => clear(thread)} className="flex h-9 items-center gap-1.5 rounded-full px-3 text-[13px] text-ink-3 hover:text-ink" aria-label={`Clear the ${label(thread)} thread`}>
            <Trash2 size={13} /> Clear
          </button>
        )}
      </div>

      <div className="glass flex min-h-0 flex-1 flex-col rounded-[20px]">
        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {n[thread] === 0 && (
            <p className="max-w-prose text-sm leading-relaxed text-ink-3">
              {thread === "auto"
                ? `Speak or type — ${name} routes it. Say “ask my booking agent for the last 5 messages” and the exchange with the Booking agent shows up in its own tab.`
                : thread === "general"
                  ? `Talk to ${name} directly: live dashboard context, its own tools (weather, files, git, web) and your identity file.`
                  : `This thread is only you and the ${label(thread)} agent (its AnythingLLM workspace), plus anything ${name} asked it on your behalf.`}{" "}
              Anything that would change something — send, book, pay, delete — is read back on a confirmation card first.
            </p>
          )}
          <Transcript thread={thread} max={120} />
          {(state === "thinking" || state === "transcribing") && (
            <p className="mt-3 flex items-center gap-2 font-mono text-xs text-amber-soft">
              <Loader2 size={13} className="animate-spin" /> {state === "transcribing" ? "transcribing…" : "dispatching…"}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2 border-t border-white/5 p-3">
          <MicButton size={40} />
          <div className="flex-1">
            <CommandInput role={thread === "auto" ? undefined : (thread as AgentRole)} placeholder={thread === "auto" ? `Message ${name}…` : `Message ${label(thread)}…`} />
          </div>
        </div>
      </div>
      {drawer && (
        <div className="fixed inset-0 z-[75] flex justify-end bg-black/40" onClick={() => setDrawer(false)}>
          <aside className="h-full w-full max-w-2xl space-y-4 overflow-y-auto p-4" onClick={(e) => e.stopPropagation()} aria-label="Skills and MCP library">
            <div className="flex justify-end">
              <button onClick={() => setDrawer(false)} className="glass-thin grid size-9 place-items-center rounded-full text-ink-2 hover:text-ink" aria-label="Close library">
                <X size={16} />
              </button>
            </div>
            <Suspense fallback={<p className="text-sm text-ink-3">Loading…</p>}>
              <McpRegistryCard />
              <SkillsLibraryCard />
            </Suspense>
          </aside>
        </div>
      )}
    </div>
  );
}
