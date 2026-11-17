import { lazy, Suspense, useEffect } from "react";
import { WallpaperSlideshow } from "@/features/wallpaper/WallpaperSlideshow";
import { WeatherCanvas } from "@/features/weather/WeatherCanvas";
import { VoiceHUD } from "@/features/voice/VoiceHUD";
import { ConfirmCard } from "@/features/orchestrator/ConfirmCard";
import { useReminderScheduler } from "@/features/reminders/scheduler";
import { useOsBoot } from "@/features/os/thread-sync";
import { useCueScheduler } from "@/features/cues/cue-runtime";
import { Toasts } from "@/components/Toasts";
import { TopBar } from "@/shell/TopBar";
import { MobileTabs, SideRail } from "@/shell/Navigation";
import { ReelDock } from "@/shell/ReelDock";
import { useNav, type Section } from "@/stores/nav";
import { useSettings } from "@/stores/settings";
import { useLayout } from "@/core/widgets/layout-store";
import { cc } from "@/lib/cc-api";
import { platform } from "@/lib/platform";
import { CommandSection } from "@/sections/CommandSection";

// Heavier tabs load on demand.
const SECTION_VIEWS: Record<Section, React.LazyExoticComponent<() => React.JSX.Element> | (() => React.JSX.Element)> = {
  command: CommandSection,
  agents: lazy(() => import("@/sections/AgentsSection").then((m) => ({ default: m.AgentsSection }))),
  playplace: lazy(() => import("@/sections/PlayPlaceSection").then((m) => ({ default: m.PlayPlaceSection }))),
  comms: lazy(() => import("@/sections/CommsSection").then((m) => ({ default: m.CommsSection }))),
  brainstorm: lazy(() => import("@/sections/BrainstormSection").then((m) => ({ default: m.BrainstormSection }))),
  finance: lazy(() => import("@/sections/FinanceSection").then((m) => ({ default: m.FinanceSection }))),
  trading: lazy(() => import("@/sections/TradingSection").then((m) => ({ default: m.TradingSection }))),
  vault: lazy(() => import("@/sections/VaultSection").then((m) => ({ default: m.VaultSection }))),
  wallpapers: lazy(() => import("@/sections/WallpapersSection").then((m) => ({ default: m.WallpapersSection }))),
  settings: lazy(() => import("@/sections/SettingsSection").then((m) => ({ default: m.SettingsSection }))),
};

/**
 * Layer stack (back → front):
 *   WallpaperSlideshow (-z-10) → WeatherCanvas (-z-5) → shell + section →
 *   VoiceHUD / orb (z-50) → ConfirmCard (z-60) → Toasts (z-70)
 * The HUD, scheduler and confirmation gate live outside the section switch,
 * so voice sessions and alarms survive navigation.
 */
const MobileHud = lazy(() => import("@/features/hud/MobileHud").then((m) => ({ default: m.MobileHud })));
const HUD_VIEW = typeof location !== "undefined" && new URLSearchParams(location.search).get("view") === "hud";

export default function App() {
  return HUD_VIEW ? <HudApp /> : <MainApp />;
}

/** Galaxy S22 Lockdown Command Center (/mobile-hud → /cc/?view=hud). */
function HudApp() {
  useOsBoot();
  useCueScheduler();
  return (
    <>
      <Suspense fallback={<div className="grid h-dvh place-items-center bg-black font-mono text-xs text-ink-3">loading…</div>}>
        <MobileHud />
      </Suspense>
      <ConfirmCard />
      <Toasts />
    </>
  );
}

function MainApp() {
  const section = useNav((s) => s.section);
  const View = SECTION_VIEWS[section];
  useReminderScheduler();
  useOsBoot();
  useCueScheduler();
  useConfigSnapshot();
  return (
    <>
      <WallpaperSlideshow />
      <WeatherCanvas />
      <div className="flex h-dvh">
        <SideRail />
        <div className="flex min-w-0 flex-1 flex-col">
          <TopBar />
          <main className="min-h-0 flex-1">
            <Suspense fallback={<div className="grid h-full place-items-center font-mono text-xs text-ink-3">loading…</div>}>
              <View />
            </Suspense>
          </main>
          {section === "command" && <ReelDock />}
        </div>
      </div>
      <MobileTabs />
      <VoiceHUD />
      <ConfirmCard />
      <Toasts />
    </>
  );
}

/**
 * Mirror this device's UI configuration (settings + widget layout) to the
 * gateway, so the scheduled backup captures it and you can restore it on a
 * new device. Debounced; never includes secrets (those live in the keychain).
 */
function useConfigSnapshot() {
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    const push = () => {
      clearTimeout(t);
      t = setTimeout(() => {
        const { set: _set, ...settings } = useSettings.getState();
        const layout = useLayout.getState().instances;
        void cc.kvSet(`ui.${platform}`, { settings, layout, at: Date.now() }).catch(() => undefined);
      }, 5000);
    };
    push();
    const a = useSettings.subscribe(push);
    const b = useLayout.subscribe(push);
    return () => {
      a();
      b();
      clearTimeout(t);
    };
  }, []);
}
