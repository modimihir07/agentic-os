import { lazy } from "react";
import { StickyNote } from "lucide-react";
import { defineWidget } from "@/core/widgets/types";

export default defineWidget({
  id: "quick-notes",
  title: "Quick Notes",
  description: "Scratchpad saved with the widget. Each instance keeps its own note.",
  icon: StickyNote,
  defaultSize: { w: 3, h: 3 },
  minSize: { w: 2, h: 2 },
  defaultConfig: { text: "" },
  component: lazy(() => import("./QuickNotes")),
});
