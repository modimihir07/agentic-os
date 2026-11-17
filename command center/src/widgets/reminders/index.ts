import { lazy } from "react";
import { AlarmClock } from "lucide-react";
import { defineWidget } from "@/core/widgets/types";

export default defineWidget({
  id: "reminders",
  title: "Alarms & Dates",
  description: "Alarms, reminders and countdowns — set them by voice (“remind me to … at 7”) or here. Synced with Google Calendar via n8n.",
  icon: AlarmClock,
  defaultSize: { w: 3, h: 3 },
  minSize: { w: 2, h: 2 },
  defaultConfig: {},
  component: lazy(() => import("./Reminders")),
});
