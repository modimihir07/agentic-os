import { lazy } from "react";
import { Target } from "lucide-react";
import { defineWidget } from "@/core/widgets/types";

export default defineWidget({
  id: "mantra",
  title: "Mantra",
  description: "Focus / Discipline / Consistency hero with the daily quote. Sits directly on the wallpaper.",
  icon: Target,
  defaultSize: { w: 6, h: 3 },
  minSize: { w: 4, h: 2 },
  chromeless: true,
  defaultConfig: { showQuote: true },
  component: lazy(() => import("./Mantra")),
});
