import { useState } from "react";
import { Plus, RotateCcw } from "lucide-react";
import { WidgetGrid } from "@/core/widgets/WidgetGrid";
import { availableWidgets } from "@/core/widgets/registry";
import { useLayout } from "@/core/widgets/layout-store";

export function CommandSection() {
  const editing = useLayout((s) => s.editing);
  return (
    <div className="flex h-full min-h-0 flex-col">
      {editing && <WidgetTray />}
      <div className="min-h-0 flex-1 overflow-y-auto md:overflow-visible">
        <WidgetGrid />
      </div>
    </div>
  );
}

/** "Add widget" tray, populated straight from the registry. */
function WidgetTray() {
  const { add, reset } = useLayout();
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <div className="mx-4 mb-3 md:mx-6 xl:mx-8">
      <div className="glass flex items-center gap-2 overflow-x-auto rounded-[18px] p-2">
        <span className="label-caps shrink-0 px-2 text-amber-soft">Add</span>
        {availableWidgets().map((w) => {
          const Icon = w.icon;
          return (
            <button
              key={w.id}
              title={w.description}
              onClick={() => {
                const r = add(w.id);
                setMsg(r.ok ? null : (r.reason ?? null));
              }}
              className="pill-glass !h-9 shrink-0 !px-3 text-[13px]"
            >
              <Plus size={13} />
              <Icon size={14} className="text-teal" />
              {w.title}
            </button>
          );
        })}
        <button onClick={reset} className="pill-glass ml-auto !h-9 shrink-0 !px-3 text-[13px]" title="Restore the default layout">
          <RotateCcw size={13} /> Reset
        </button>
      </div>
      {msg && <p className="mt-2 px-2 text-xs text-alert">{msg}</p>}
      <p className="mt-2 hidden px-2 text-xs text-ink-3 md:block">Drag a widget’s label to move it, its corner to resize. Red outline = no room there.</p>
    </div>
  );
}
