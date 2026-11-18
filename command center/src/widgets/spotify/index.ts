import { lazy } from "react";
import { Music2 } from "lucide-react";
import { defineWidget } from "@/core/widgets/types";
import type { QuickList } from "./spotify-ui";

export default defineWidget({
  id: "spotify",
  title: "Spotify",
  description: "Now playing with play / pause / skip / volume, plus your recent tracks and playlists. Desktop app; playback control needs Premium.",
  icon: Music2,
  defaultSize: { w: 3, h: 3 },
  minSize: { w: 3, h: 2 },
  maxSize: { w: 6, h: 4 },
  keywords: ["spotify", "music", "now playing", "player", "playlist", "song"],
  defaultConfig: { quick: "recent" as QuickList },
  component: lazy(() => import("./Spotify")),
});
