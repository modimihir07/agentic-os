import { WallpaperSlideshow } from "@/features/wallpaper/WallpaperSlideshow";
import { WeatherCanvas } from "@/features/weather/WeatherCanvas";
import { VoiceHUD } from "@/features/voice/VoiceHUD";
import { ConfirmCard } from "@/features/orchestrator/ConfirmCard";
import { TopBar } from "@/shell/TopBar";
import { MobileTabs, SideRail } from "@/shell/Navigation";
import { ReelDock } from "@/shell/ReelDock";
import { useNav, type Section } from "@/stores/nav";
import { CommandSection } from "@/sections/CommandSection";
import { AgentsSection } from "@/sections/AgentsSection";
import { WallpapersSection } from "@/sections/WallpapersSection";
import { SettingsSection } from "@/sections/SettingsSection";

const SECTION_VIEWS: Record<Section, () => React.JSX.Element> = {
  command: CommandSection,
  agents: AgentsSection,
  wallpapers: WallpapersSection,
  settings: SettingsSection,
};

/**
 * Layer stack (back → front):
 *   WallpaperSlideshow (-z-10) → WeatherCanvas (-z-5) → shell + section → VoiceHUD (portal, z-50)
 * The HUD lives outside the section switch so a voice session survives navigation.
 */
export default function App() {
  const section = useNav((s) => s.section);
  const View = SECTION_VIEWS[section];
  return (
    <>
      <WallpaperSlideshow />
      <WeatherCanvas />
      <div className="flex h-dvh">
        <SideRail />
        <div className="flex min-w-0 flex-1 flex-col">
          <TopBar />
          <main className="min-h-0 flex-1">
            <View />
          </main>
          {section === "command" && <ReelDock />}
        </div>
      </div>
      <MobileTabs />
      <VoiceHUD />
      <ConfirmCard />
    </>
  );
}
