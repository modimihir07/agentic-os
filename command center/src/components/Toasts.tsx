import { createPortal } from "react-dom";
import { AlarmClock, Info, TriangleAlert, X } from "lucide-react";
import { useToasts } from "@/features/reminders/notify";

export function Toasts() {
  const { toasts, dismiss } = useToasts();
  if (!toasts.length) return null;
  return createPortal(
    <div className="pointer-events-none fixed inset-x-0 top-[calc(env(safe-area-inset-top)+4.5rem)] z-[70] flex flex-col items-center gap-2 px-4" aria-live="assertive">
      <style>{`@keyframes toast-in{from{opacity:0;transform:translateY(-8px) scale(.98)}to{opacity:1;transform:none}}`}</style>
      {toasts.map((t) => {
        const Icon = t.tone === "alarm" ? AlarmClock : t.tone === "error" ? TriangleAlert : Info;
        return (
          <div
            key={t.id}
            role={t.tone === "alarm" ? "alertdialog" : "status"}
            className={`glass pointer-events-auto flex w-[min(440px,100%)] items-start gap-3 rounded-[16px] p-3.5 animate-[toast-in_220ms_cubic-bezier(0.23,1,0.32,1)] ${
              t.tone === "alarm" ? "border-amber/60 glow-amber" : t.tone === "error" ? "border-alert/50" : ""
            }`}
          >
            <Icon size={18} className={t.tone === "alarm" ? "mt-0.5 text-amber" : t.tone === "error" ? "mt-0.5 text-alert" : "mt-0.5 text-teal"} />
            <div className="min-w-0 flex-1">
              <p className="font-medium text-ink">{t.title}</p>
              {t.body && <p className="mt-0.5 text-sm text-ink-2">{t.body}</p>}
              {t.actions && (
                <div className="mt-2 flex gap-2">
                  {t.actions.map((a) => (
                    <button key={a.label} onClick={a.run} className="pill-glass !h-8 !px-3 text-xs">
                      {a.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <button onClick={() => dismiss(t.id)} aria-label="Dismiss" className="grid size-7 place-items-center rounded-full text-ink-3 hover:text-ink">
              <X size={14} />
            </button>
          </div>
        );
      })}
    </div>,
    document.body,
  );
}
