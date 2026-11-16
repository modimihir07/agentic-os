import type { ComponentType, LazyExoticComponent } from "react";
import type { LucideIcon } from "lucide-react";
import type { Platform } from "@/lib/platform";

/**
 * The widget contract. Every widget lives in `src/widgets/<id>/index.ts` and
 * default-exports `defineWidget({...})`. The registry discovers it automatically —
 * no central list to edit, no layout code to touch.
 */
export interface WidgetProps<C = Record<string, unknown>> {
  instanceId: string;
  config: C;
  /** Persist a config change for this instance. */
  setConfig: (patch: Partial<C>) => void;
  /** Current size in grid units, so widgets can render compact/expanded variants. */
  size: { w: number; h: number };
}

export interface WidgetDefinition<C = Record<string, unknown>> {
  id: string;
  title: string;
  description: string;
  icon: LucideIcon;
  /** Grid units on the 12-column × 8-row desktop canvas. */
  defaultSize: { w: number; h: number };
  minSize?: { w: number; h: number };
  maxSize?: { w: number; h: number };
  /** Omit to allow everywhere. */
  platforms?: Platform[];
  defaultConfig: C;
  /** Phone stack position (lower = higher up). Defaults to the desktop row. */
  compactOrder?: number;
  /** Draw without a glass card (e.g. the mantra hero that sits directly on the wallpaper). */
  chromeless?: boolean;
  /** Lazy so each widget is its own chunk and a crash in one never takes down the grid. */
  component: LazyExoticComponent<ComponentType<WidgetProps<C>>>;
}

export interface WidgetInstance {
  instanceId: string;
  widgetId: string;
  /** 1-based grid placement. */
  col: number;
  row: number;
  w: number;
  h: number;
  config: Record<string, unknown>;
}

export function defineWidget<C extends Record<string, unknown>>(def: WidgetDefinition<C>): WidgetDefinition<C> {
  return def;
}
