import { lazy } from "react";
import { AudioLines } from "lucide-react";
import { defineWidget } from "@/core/widgets/types";

export default defineWidget({
  id: "voice-console",
  title: "Voice Console",
  description: "The voice HUD docked on the board: big glowing waveform, last exchange, mic and typed command. The floating HUD hides while this is visible.",
  icon: AudioLines,
  defaultSize: { w: 6, h: 3 },
  minSize: { w: 4, h: 2 },
  compactOrder: 0, // voice-first: top of the phone stack
  defaultConfig: {},
  component: lazy(() => import("./VoiceConsole")),
});
