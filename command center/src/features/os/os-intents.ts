/**
 * Native OS-control intents — the executing half. Local, reversible controls
 * (Gabagool, stop-audio, workspace switch, model swap, compute mode, kill
 * switch, status) run in-process: no gateway hop, no confirmation card.
 *
 * Called from `voice-controller.ts handleInput` right after the stop/cue
 * checks and BEFORE idea capture, local intents and the planner, so a phrase
 * like "turn off gabagool mode" can never reach a gateway agent.
 */
import { collections } from "@/lib/cc-api";
import { cmd, isTauri } from "@/lib/platform";
import { useNav } from "@/stores/nav";
import { useSettings } from "@/stores/settings";
import { fireCue } from "@/features/cues/cue-runtime";
import { cueRecentlyActive, gabagoolOn, stopAllAudio, useCueRun } from "@/features/cues/player";
import type { CueWidget } from "@/features/cues/types";
import { useHealthStore } from "@/features/services/use-health";
import { useVoice } from "@/features/voice/voice-store";
import { roleLabel } from "@/features/dispatcher/roles";
import { useOs } from "./os-store";
import { parseOsIntent, resolveModel, type OsIntent, type WorkspaceId } from "./os-intent-parse";

export interface OsIntentResult {
  /** Spoken/shown reply; "" means the action already speaks for itself (a cue's intro). */
  reply: string;
}

/** Parse + execute. Returns null for anything that isn't an OS-control phrase. */
export async function handleOsIntent(text: string): Promise<OsIntentResult | null> {
  const osName = useSettings.getState().osName || "Tony";
  const intent = parseOsIntent(text, { osName, cueActive: cueRecentlyActive() });
  if (!intent) return null;
  return run(intent);
}

async function run(intent: OsIntent): Promise<OsIntentResult> {
  switch (intent.kind) {
    case "gabagool-on":
      return gabagoolOnAction();
    case "gabagool-off":
      return gabagoolOffAction(intent.explicit);
    case "workspace":
      return workspaceAction(intent.thread);
    case "model":
      return modelAction(intent.query);
    case "compute":
      return computeAction(intent.mode);
    case "kill-switch":
      return killSwitchAction(intent.on);
    case "status":
      return { reply: statusSummary() };
  }
}

function gabagoolOnAction(): OsIntentResult {
  if (gabagoolOn()) return { reply: "Gabagool mode is already on." };
  const w = collections.snapshot<CueWidget>("cues").find((c) => c.builtin === "gabagool" && !c._deleted);
  if (!w) return { reply: "Gabagool mode isn't set up yet — add it in Settings → Voice & Triggers." };
  if (!w.enabled) return { reply: "Gabagool mode is turned off in Settings → Voice & Triggers." };
  fireCue(w);
  // The cue speaks its own intro line; no extra reply needed.
  return { reply: "" };
}

function gabagoolOffAction(explicit: boolean): OsIntentResult {
  // `explicit: false` only reaches here when a cue is running or fired within the last
  // 10 minutes (parseOsIntent's cueActive gate) — always worth stopping (and cancelling
  // any TTS still mid-intro), even if the cue itself already finished.
  const wasActive = !!useCueRun.getState().running || gabagoolOn();
  stopAllAudio();
  if (!wasActive && explicit) return { reply: "Gabagool mode is already off." };
  return { reply: "Gabagool mode off." };
}

function workspaceAction(thread: WorkspaceId): OsIntentResult {
  useVoice.getState().setActiveThread(thread);
  useNav.getState().go("agents");
  return { reply: thread === "auto" ? "Switched to auto-routing." : `Switched to ${roleLabel(thread)}.` };
}

async function modelAction(query: string): Promise<OsIntentResult> {
  if (!isTauri()) return { reply: "Model switching needs the desktop app." };
  try {
    const models = await cmd("provider_models", { id: "lmstudio" });
    const id = resolveModel(query, models);
    if (!id) return { reply: `I couldn't find a model matching "${query}".` };
    await cmd("model_use", { model: id });
    return { reply: `Switched the model to ${id}.` };
  } catch (e) {
    return { reply: `Couldn't switch models: ${e instanceof Error ? e.message : String(e)}` };
  }
}

async function computeAction(mode: "local" | "hybrid" | "cloud"): Promise<OsIntentResult> {
  if (!isTauri()) return { reply: "Compute mode needs the desktop app." };
  try {
    await useOs.getState().patch({ compute: { mode } });
    return { reply: `Compute mode: ${mode.toUpperCase()}.` };
  } catch (e) {
    return { reply: `Couldn't change compute mode: ${e instanceof Error ? e.message : String(e)}` };
  }
}

async function killSwitchAction(on: boolean): Promise<OsIntentResult> {
  if (!isTauri()) return { reply: "The kill switch needs the desktop app." };
  try {
    await useOs.getState().patch({ privacy: { killSwitch: on } });
    return { reply: on ? "Kill switch on — everything stays local." : "Kill switch off — cloud routing restored." };
  } catch (e) {
    return { reply: `Couldn't change the kill switch: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** A short status line from what's already on screen — no LLM call. */
function statusSummary(): string {
  const svc = useHealthStore.getState().services;
  const cfg = useOs.getState().cfg;
  if (!svc.length) return "No service status yet — check the Services page.";
  const up = svc.filter((s) => s.up).length;
  const down = svc.filter((s) => !s.up);
  const parts = [`${up}/${svc.length} services up`];
  if (down.length) parts.push(`down: ${down.map((s) => s.label).join(", ")}`);
  if (cfg) parts.push(`compute ${cfg.compute.mode}${cfg.privacy.killSwitch ? " · kill switch on" : ""}`);
  return parts.join(" · ");
}
