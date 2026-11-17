import { create } from "zustand";
import type { LucideIcon } from "lucide-react";
import { CandlestickChart, FlaskConical, Gauge, Image, Lightbulb, MessagesSquare, Phone, Receipt, Search, Settings2 } from "lucide-react";

export type Section = "command" | "agents" | "playplace" | "comms" | "brainstorm" | "finance" | "trading" | "vault" | "wallpapers" | "settings";

export const SECTIONS: { id: Section; label: string; icon: LucideIcon; mobile: boolean }[] = [
  { id: "command", label: "Command", icon: Gauge, mobile: true },
  { id: "agents", label: "Agents", icon: MessagesSquare, mobile: true },
  { id: "playplace", label: "Play Place", icon: FlaskConical, mobile: false },
  { id: "comms", label: "Comms", icon: Phone, mobile: true },
  { id: "brainstorm", label: "Brainstorm", icon: Lightbulb, mobile: true },
  { id: "finance", label: "Finance", icon: Receipt, mobile: true },
  { id: "trading", label: "Trading", icon: CandlestickChart, mobile: false },
  { id: "vault", label: "Vault", icon: Search, mobile: false },
  { id: "wallpapers", label: "Wallpapers", icon: Image, mobile: false },
  { id: "settings", label: "Settings", icon: Settings2, mobile: false },
];

const fromHash = (): Section => {
  const h = location.hash.replace("#/", "").split("/")[0] as Section;
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
