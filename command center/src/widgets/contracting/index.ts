import { lazy } from "react";
import { HardHat } from "lucide-react";
import { defineWidget } from "@/core/widgets/types";

export default defineWidget({
  id: "contracting",
  title: "Contracting Tracker",
  description: "Job estimates, bids and client follow-ups, with pipeline value. Won jobs become invoice drafts.",
  icon: HardHat,
  defaultSize: { w: 3, h: 3 },
  minSize: { w: 3, h: 2 },
  defaultConfig: {},
  component: lazy(() => import("./Contracting")),
});
