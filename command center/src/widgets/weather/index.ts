import { lazy } from "react";
import { CloudSun } from "lucide-react";
import { defineWidget } from "@/core/widgets/types";

export default defineWidget({
  id: "weather",
  title: "Living Weather",
  description: "Live conditions (Open-Meteo, no key) and the atmosphere switcher that drives the particle layer.",
  icon: CloudSun,
  defaultSize: { w: 3, h: 2 },
  minSize: { w: 2, h: 2 },
  defaultConfig: {},
  component: lazy(() => import("./Weather")),
});
