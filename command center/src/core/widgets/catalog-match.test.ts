import { describe, expect, it } from "vitest";
import { matchCatalog, type CatalogEntry } from "./catalog-match";

const DEFS: CatalogEntry[] = [
  { id: "custom", title: "Custom Widget" },
  { id: "spotify", title: "Spotify", keywords: ["spotify", "music", "now playing", "player", "playlist", "song"] },
  { id: "weather", title: "Living Weather" },
  { id: "pipeline", title: "Audition Pipeline" },
  { id: "n8n-pipelines", title: "n8n Pipelines & Drive Sync" },
  { id: "quick-notes", title: "Quick Notes" },
  { id: "system-stats", title: "System" },
];
const m = (p: string) => matchCatalog(p, DEFS)?.id ?? null;

describe("matchCatalog", () => {
  it("matches ids, titles and keywords as whole words", () => {
    expect(m("spotify")).toBe("spotify");
    expect(m("Add a Spotify player please")).toBe("spotify");
    expect(m("what's now playing")).toBe("spotify");
    expect(m("my playlists")).toBe("spotify");
    expect(m("living weather")).toBe("weather");
    expect(m("quick notes")).toBe("quick-notes");
    expect(m("quick-notes")).toBe(null);
  });

  it("prefers the longest term", () => {
    expect(m("n8n pipelines")).toBe("n8n-pipelines");
    expect(m("audition pipeline")).toBe("pipeline");
  });

  it("leaves real generator prompts to the LLM", () => {
    expect(m("HST paid on fuel receipts")).toBe(null);
    expect(m("countdown to my Dec 12 shoot")).toBe(null);
    expect(m("songwriting deadlines")).toBe(null);
    expect(m("a custom widget")).toBe(null);
    expect(m("   ")).toBe(null);
  });

  it("only matches a prompt that is essentially the widget's name", () => {
    expect(m("countdown to the music festival on June 3")).toBe(null);
    expect(m("stat of how many songs I wrote this year")).toBe(null);
    expect(m("my sales pipeline total as a progress bar")).toBe(null);
    expect(m("system uptime checklist")).toBe(null);
    expect(m("put the spotify widget on my dashboard")).toBe("spotify");
    expect(m("show me the music player")).toBe("spotify");
  });
});
