import { lazy } from "react";
import { Activity } from "lucide-react";
import { defineWidget } from "@/core/widgets/types";

export default defineWidget({
  id: "data-streams",
  title: "Data Streams",
  description: "Docker, NetBird, n8n and Gmail connectors in one feed.",
  icon: Activity,
  defaultSize: { w: 3, h: 4 },
  minSize: { w: 3, h: 2 },
  defaultConfig: {},
  component: lazy(() => import("./DataStreams")),
});
