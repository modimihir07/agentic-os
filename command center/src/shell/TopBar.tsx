import { useEffect } from "react";
import { Command, LayoutGrid, Check } from "lucide-react";
import { useSettings } from "@/stores/settings";
import { useNav } from "@/stores/nav";
import { useLayout } from "@/core/widgets/layout-store";
import { AtmosphereSwitch } from "@/widgets/weather/Weather";
import { useVoice } from "@/features/voice/voice-store";
import { ActiveSlotPill, ComputeModeSwitch, DropletBadge, GabagoolPill, KillSwitch, PrivacyPill } from "@/features/os/OsControls";

export function TopBar() {
  const identity = useSettings((s) => s.identity);
  const weatherMode = useSettings((s) => s.weatherMode);
  const section = useNav((s) => s.section);
  const { editing, setEditing } = useLayout();

  // The HUD's typed input autofocuses when the panel expands.
  const openCommand = () => useVoice.getState().setExpanded(true);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        openCommand();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <header className="flex items-center gap-3 px-4 pb-3 pt-[calc(env(safe-area-inset-top)+0.75rem)] md:px-6 xl:px-8">
      <div className="glass-thin flex h-11 min-w-0 items-center gap-3 rounded-full px-4">
        <span className="size-2 shrink-0 rounded-full bg-amber shadow-[0_0_10px_#ff7a2f]" />
        <span className="truncate font-mono text-[13px] font-semibold tracking-wider text-ink">{identity.callsign}</span>
        <span className="hidden h-4 w-px bg-white/15 sm:block" />
        <span className="label-caps hidden text-teal sm:block">{identity.subtitle}</span>
      </div>

      <button onClick={openCommand} className="glass-thin hidden h-11 items-center gap-2 rounded-full px-4 text-ink-2 transition-colors hover:text-ink md:flex">
        <Command size={14} />
        <span className="label-caps">Command</span>
        <kbd className="label-caps rounded border border-white/10 px-1.5 text-ink-3">Ctrl K</kbd>
      </button>

      <div className="ml-auto hidden md:flex md:items-center md:gap-2">
        <ActiveSlotPill />
        <ComputeModeSwitch compact />
        <DropletBadge />
        <GabagoolPill />
        <PrivacyPill />
        <KillSwitch />
      </div>

      <div className="hidden lg:block">
        <AtmosphereSwitch mode={weatherMode} className="glass-thin !bg-[rgba(11,13,17,0.42)]" />
      </div>

      {section === "command" && (
        <div className="ml-auto md:ml-0">
          <EditToggle editing={editing} setEditing={setEditing} />
        </div>
      )}
    </header>
  );
}

function EditToggle({ editing, setEditing }: { editing: boolean; setEditing: (v: boolean) => void }) {
  return (
    <button
      onClick={() => setEditing(!editing)}
      aria-pressed={editing}
      className={`flex h-11 items-center gap-2 rounded-full px-4 transition-colors ${editing ? "bg-amber text-canvas glow-amber" : "glass-thin text-ink-2 hover:text-ink"}`}
    >
      {editing ? <Check size={15} /> : <LayoutGrid size={15} />}
      <span className="label-caps">{editing ? "Done" : "Widgets"}</span>
    </button>
  );
}
