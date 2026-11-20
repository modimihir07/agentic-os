import { create } from "zustand";
import type { TraceZone } from "@/lib/platform";

/**
 * Which car zone is hovered (glows in the 3D view) and which one's inspector drawer is
 * open. Shared by the HoloViewport, the callout cards and the ZoneInspector. UI-only.
 */
interface ZoneUi {
  hovered: TraceZone | null;
  selected: TraceZone | null;
  hover: (z: TraceZone | null) => void;
  /** Open a zone's inspector; selecting the open zone again closes it. */
  select: (z: TraceZone | null) => void;
}

export const useZoneUi = create<ZoneUi>((set, get) => ({
  hovered: null,
  selected: null,
  hover: (z) => {
    if (get().hovered !== z) set({ hovered: z });
  },
  select: (z) => set({ selected: z != null && get().selected === z ? null : z }),
}));

export const ZONE_TITLE: Record<TraceZone, string> = {
  engine: "Engine bay // local inference & dispatch",
  ecu: "ECU & wiring harness // rules, skills, routines",
  cockpit: "Dashboard & console // I/O & voice",
  cargo: "Cargo trunk // persistent memory & RAG",
  exhaust: "Exhaust // external MCP protocols",
};
