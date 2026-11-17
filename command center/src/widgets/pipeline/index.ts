import { lazy } from "react";
import { Clapperboard } from "lucide-react";
import { defineWidget } from "@/core/widgets/types";

export default defineWidget({
  id: "pipeline",
  title: "Audition Pipeline",
  description: "Scripts received, self-tape deadlines, callbacks and bookings — with countdowns.",
  icon: Clapperboard,
  defaultSize: { w: 3, h: 3 },
  minSize: { w: 3, h: 2 },
  defaultConfig: {},
  component: lazy(() => import("./Pipeline")),
});
