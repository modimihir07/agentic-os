import { platform } from "@/lib/platform";
import type { WidgetDefinition } from "./types";

// Auto-discovery: any folder under src/widgets with an index.ts that
// default-exports a WidgetDefinition becomes available in the "Add widget" tray.
const modules = import.meta.glob<{ default: WidgetDefinition<any> }>("../../widgets/*/index.ts", { eager: true });

const registry = new Map<string, WidgetDefinition<any>>();

for (const [path, mod] of Object.entries(modules)) {
  const def = mod.default;
  if (!def?.id) {
    console.warn(`[widgets] ${path} has no default WidgetDefinition export — skipped`);
    continue;
  }
  if (registry.has(def.id)) {
    console.warn(`[widgets] duplicate widget id "${def.id}" in ${path} — skipped`);
    continue;
  }
  registry.set(def.id, def);
}

export function getWidget(id: string): WidgetDefinition<any> | undefined {
  return registry.get(id);
}

/** Widgets usable on the current platform, sorted by title. */
export function availableWidgets(): WidgetDefinition<any>[] {
  return [...registry.values()]
    .filter((w) => !w.platforms || w.platforms.includes(platform))
    .sort((a, b) => a.title.localeCompare(b.title));
}
