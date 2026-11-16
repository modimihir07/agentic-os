import { useEffect, useState } from "react";
import type { WidgetProps } from "@/core/widgets/types";
import { WidgetHeader } from "@/components/WidgetHeader";

export default function QuickNotes({ config, setConfig, instanceId }: WidgetProps<{ text: string }>) {
  const [text, setText] = useState(config.text);
  const [saved, setSaved] = useState(true);

  // Debounced persist so typing doesn't write storage on every keystroke.
  useEffect(() => {
    if (text === config.text) return;
    setSaved(false);
    const t = setTimeout(() => {
      setConfig({ text });
      setSaved(true);
    }, 500);
    return () => clearTimeout(t);
  }, [text, config.text, setConfig]);

  return (
    <div className="flex h-full flex-col">
      <WidgetHeader title="Notes" status={<span className="label-caps text-ink-3">{saved ? "Saved" : "Saving…"}</span>} />
      <label htmlFor={`notes-${instanceId}`} className="sr-only">
        Quick notes
      </label>
      <textarea
        id={`notes-${instanceId}`}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Capture a thought…"
        className="well min-h-24 w-full flex-1 resize-none rounded-[12px] bg-transparent p-3 font-mono text-[13px] leading-relaxed text-ink outline-none placeholder:text-ink-3 focus:ring-1 focus:ring-teal/60"
      />
    </div>
  );
}
