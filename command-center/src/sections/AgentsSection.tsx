import { useState } from "react";
import { Loader2, Trash2 } from "lucide-react";
import { SUB_AGENTS, type AgentRole } from "@/features/dispatcher/agents";
import { useVoice } from "@/features/voice/voice-store";
import { CommandInput, MicButton, Transcript } from "@/features/voice/VoiceParts";

/**
 * Full-screen view of the same conversation the voice HUD drives. Typed
 * commands go through the identical plan → confirm → execute path.
 */
export function AgentsSection() {
  const [role, setRole] = useState<AgentRole | "auto">("auto");
  const state = useVoice((s) => s.state);
  const hasTurns = useVoice((s) => s.turns.length > 0);
  const clear = useVoice((s) => s.clear);

  return (
    <div className="mx-auto flex h-full w-full max-w-4xl flex-col px-4 pb-28 md:px-6 md:pb-6">
      <div className="mb-3 flex flex-wrap gap-2" role="radiogroup" aria-label="Sub-agent">
        {(["auto", ...Object.keys(SUB_AGENTS)] as (AgentRole | "auto")[]).map((r) => {
          const a = r === "auto" ? null : SUB_AGENTS[r];
          const Icon = a?.icon;
          return (
            <button
              key={r}
              role="radio"
              aria-checked={role === r}
              onClick={() => setRole(r)}
              className={`flex h-9 items-center gap-2 rounded-full border px-3.5 text-[13px] transition-colors ${
                role === r ? "border-amber/60 bg-amber/15 text-ink" : "border-white/10 bg-[rgba(11,13,17,0.45)] text-ink-2 backdrop-blur-md hover:text-ink"
              }`}
            >
              {Icon && <Icon size={14} />}
              {a?.label ?? "Auto-route"}
            </button>
          );
        })}
        {hasTurns && (
          <button onClick={clear} className="ml-auto flex h-9 items-center gap-1.5 rounded-full px-3 text-[13px] text-ink-3 hover:text-ink" aria-label="Clear conversation">
            <Trash2 size={13} /> Clear
          </button>
        )}
      </div>

      <div className="glass flex min-h-0 flex-1 flex-col rounded-[20px]">
        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {!hasTurns && (
            <p className="max-w-prose text-sm leading-relaxed text-ink-3">
              Speak or type. The dispatcher routes questions straight to an agent. Anything that would change something — cancel, send, book, pay,
              delete, deploy — is shown on a confirmation card and read back to you first, and nothing happens until you say “yes” or tap Approve.
            </p>
          )}
          <Transcript />
          {(state === "thinking" || state === "transcribing") && (
            <p className="mt-3 flex items-center gap-2 font-mono text-xs text-amber-soft">
              <Loader2 size={13} className="animate-spin" /> {state === "transcribing" ? "transcribing…" : "dispatching…"}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2 border-t border-white/5 p-3">
          <MicButton size={40} />
          <div className="flex-1">
            <CommandInput role={role === "auto" ? undefined : role} placeholder="Message the dispatcher…" />
          </div>
        </div>
      </div>
    </div>
  );
}
