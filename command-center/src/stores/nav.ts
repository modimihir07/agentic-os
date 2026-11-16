import { create } from "zustand";
import type { LucideIcon } from "lucide-react";
import { Gauge, Image, MessagesSquare, Settings2 } from "lucide-react";

export type Section = "command" | "agents" | "wallpapers" | "settings";

export const SECTIONS: { id: Section; label: string; icon: LucideIcon }[] = [
  { id: "command", label: "Command", icon: Gauge },
  { id: "agents", label: "Agents", icon: MessagesSquare },
  { id: "wallpapers", label: "Wallpapers", icon: Image },
  { id: "settings", label: "Settings", icon: Settings2 },
];

const fromHash = (): Section => {
  const h = location.hash.replace("#/", "") as Section;
  return SECTIONS.some((s) => s.id === h) ? h : "command";
};

export const useNav = create<{ section: Section; go: (s: Section) => void }>((set) => ({
  section: fromHash(),
  go: (section) => {
    history.replaceState(null, "", `#/${section}`);
    set({ section });
  },
}));

window.addEventListener("hashchange", () => useNav.setState({ section: fromHash() }));
