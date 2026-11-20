import { lazy } from "react";
import { Wand2 } from "lucide-react";
import { defineWidget } from "@/core/widgets/types";
import type { CustomSpec } from "./spec";

export default defineWidget<{ spec: CustomSpec | null }>({
  id: "custom",
  title: "Custom Widget",
  description: "A widget generated from a description (“unpaid invoices”, “HST paid this quarter”…) by the local LLM, or built from a template.",
  icon: Wand2,
  defaultSize: { w: 3, h: 2 },
  minSize: { w: 2, h: 2 },
  defaultConfig: { spec: null },
  component: lazy(() => import("./CustomWidget")),
});
