import { lazy } from "react";
import { Cpu } from "lucide-react";
import { defineWidget } from "@/core/widgets/types";

export default defineWidget({
  id: "system-stats",
  title: "System",
  description: "CPU, RAM and GPU/VRAM telemetry (desktop) or gateway reachability (mobile).",
  icon: Cpu,
  defaultSize: { w: 3, h: 2 },
  minSize: { w: 2, h: 2 },
  defaultConfig: { pollMs: 3000 },
  component: lazy(() => import("./SystemStats")),
});
