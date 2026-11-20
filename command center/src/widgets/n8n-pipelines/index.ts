import { lazy } from "react";
import { Workflow } from "lucide-react";
import { defineWidget } from "@/core/widgets/types";

export default defineWidget({
  id: "n8n-pipelines",
  title: "n8n Pipelines & Drive Sync",
  description: "Live status of every n8n workflow across local + remote instances, with Run / Pause and a Google Drive backup trigger.",
  icon: Workflow,
  defaultSize: { w: 6, h: 2 },
  minSize: { w: 4, h: 2 },
  platforms: ["desktop"],
  defaultConfig: {},
  component: lazy(() => import("./Pipelines")),
});
