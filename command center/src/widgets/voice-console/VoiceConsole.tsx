import { useEffect, useRef } from "react";
import type { WidgetProps } from "@/core/widgets/types";
import { STATE_LABEL, useThreadTurns, useVoice } from "@/features/voice/voice-store";
import { useOsName } from "@/features/os/os-store";
import { Waveform } from "@/features/voice/Waveform";
import { CommandInput, MicButton, STATE_DOT } from "@/features/voice/VoiceParts";
import { voiceCaps } from "@/features/voice/voice-controller";

/** The docked voice HUD — anchored centre stage on the Command board. */
export default function VoiceConsole({ size }: WidgetProps) {
  const { state, partial, error } = useVoice();
  const turns = useThreadTurns();
  const name = useOsName();
  const setConsoleVisible = useVoice((s) => s.setConsoleVisible);
  const ref = useRef<HTMLDivElement>(null);

  // While at least half of this widget is on screen, the floating HUD hides.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setConsoleVisible(e.intersectionRatio >= 0.5), { threshold: [0, 0.5, 1] });
    io.observe(el);
    return () => {
      io.disconnect();
      setConsoleVisible(false);
    };
  }, [setConsoleVisible]);

  const lastUser = turns.filter((t) => t.who === "user").at(-1);
  const lastAgent = [...turns].reverse().find((t) => t.who !== "user");
  const tall = size.h >= 3;

  return (
    <div ref={ref} className="flex h-full min-h-44 flex-col">
      <header className="flex items-center gap-2.5">
        <span className={`size-2 rounded-full ${STATE_DOT[state]}`} />
        <h2 className="label-caps text-ink">{name} voice</h2>
        <span className="label-caps hidden rounded-full border border-amber/30 px-2 py-0.5 text-amber-soft sm:inline">{voiceCaps.sttName}</span>
        <span className="label-caps ml-auto text-teal">{STATE_LABEL[state]}</span>
      </header>

      <div className="flex min-h-0 flex-1 items-center gap-4 py-2">
        <MicButton size={tall ? 56 : 44} />
        <Waveform state={state} height={tall ? 110 : 64} className="flex-1" />
      </div>

      <div className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
        <p className="line-clamp-2 min-w-0">
          <span className="label-caps mr-2 text-amber">Query</span>
          <span className="italic text-ink">{partial ? `“${partial}”` : lastUser ? `“${lastUser.text}”` : `Say “Hey ${name}, …” or press the mic`}</span>
        </p>
        <p className={`line-clamp-2 min-w-0 ${error ? "text-alert" : "text-ink"}`}>
          <span className="label-caps mr-2 text-teal">{name}</span>
          {error ?? lastAgent?.text ?? "Standing by."}
        </p>
      </div>

      {tall && (
        <div className="mt-3">
          <CommandInput />
        </div>
      )}
    </div>
  );
}
