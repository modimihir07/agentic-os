import type { OverseerEngine } from "@/lib/platform";

export type OverseerFamily = "claude" | "gemini";

/** The engine used when neither Claude nor Gemini is the Overseer (the local secondary model). */
export const OVERSEER_OFF: OverseerEngine = "local";

/** The overseer runs on this family, in either API-key or CLI mode. */
export function overseerFamilyOn(engine: OverseerEngine, family: OverseerFamily): boolean {
  return engine === `${family}-cli` || engine === `${family}-api`;
}

/**
 * The engine after the "Use Claude / Gemini as the Overseer" switch is set to `on`.
 * Turning it on keeps an existing API/CLI choice of that family (never claude-api → claude-cli);
 * from another engine it starts in CLI mode. Turning it off falls back to the local model,
 * and only when that family is actually the current overseer.
 */
export function toggleOverseer(engine: OverseerEngine, family: OverseerFamily, on: boolean): OverseerEngine {
  const active = overseerFamilyOn(engine, family);
  if (on) return active ? engine : `${family}-cli`;
  return active ? OVERSEER_OFF : engine;
}
