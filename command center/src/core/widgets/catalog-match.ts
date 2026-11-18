/** What the matcher needs from a widget definition. */
export interface CatalogEntry {
  id: string;
  title: string;
  keywords?: string[];
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Words a "just add widget X" prompt may carry besides the widget's own name. */
const FILLER = new Set(
  ("add show me the a an my our please put on to in dashboard page widget widgets card panel tile new can could you " +
    "i want need get give pop what s what's whats is").split(" "),
);

/**
 * A built-in widget named in a "Generate" prompt ("spotify", "add the weather"), so it is
 * added straight away instead of asking the LLM for a data-only custom widget. Terms are
 * the id (dashes as spaces), the title and the keywords, matched as whole words (a plural
 * "s" allowed); the longest matching term wins. `custom` is never a match.
 *
 * Only a prompt that is essentially just the widget's name counts: every other word must be
 * filler or another of that widget's own terms. "countdown to the music festival" names
 * "music" but asks for something else, so it still goes to the generator.
 */
export function matchCatalog<T extends CatalogEntry>(prompt: string, defs: T[]): T | null {
  const text = prompt.toLowerCase().replace(/\s+/g, " ").trim();
  if (!text) return null;
  let best: { def: T; len: number } | null = null;
  for (const def of defs) {
    if (def.id === "custom") continue;
    const terms = [def.id.replace(/-/g, " "), def.title, ...(def.keywords ?? [])].map((t) => t.toLowerCase().replace(/\s+/g, " ").trim()).filter(Boolean);
    const own = new Set(terms.flatMap((t) => t.split(/[^a-z0-9]+/)).filter(Boolean));
    const known = (w: string) => FILLER.has(w) || own.has(w) || own.has(w.replace(/s$/, ""));
    for (const term of terms) {
      const re = new RegExp(`(^|[^a-z0-9])${escape(term)}s?(?=$|[^a-z0-9])`, "g");
      if (!re.test(text) || (best && term.length <= best.len)) continue;
      const rest = text.replace(re, " ").split(/[^a-z0-9']+/).filter(Boolean);
      if (rest.every(known)) best = { def, len: term.length };
    }
  }
  return best?.def ?? null;
}
