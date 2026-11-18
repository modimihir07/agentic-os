import { cmd, isTauri } from "@/lib/platform";
import { useSettings } from "@/stores/settings";
import type { Reminder } from "./types";

/**
 * Windows OS-alarm fallback (alarm.rs): a saved alarm / reminder also rings through Task
 * Scheduler when the app is closed. The in-app scheduler fires first and cancels it, so it
 * never rings twice. Desktop only, best effort (never throws), behind `reminders.osFallback`.
 */
const enabled = () => isTauri() && useSettings.getState().reminders.osFallback;

/** Kinds that ring (countdowns and mirrored calendar events don't). */
export const ringsOnOs = (r: Pick<Reminder, "kind" | "source">) => (r.kind === "alarm" || r.kind === "reminder") && r.source !== "gcal";

/** The Windows alarm rings this long after the due time, so a running app (10 s tick) always
 * rings first and cancels it. */
export const OS_GRACE_MS = 20_000;

/** True when the OS alarm was registered (or replaced: one task per reminder id). */
export async function scheduleOsAlarm(id: string, title: string, dueAt: number): Promise<boolean> {
  if (!enabled()) return false;
  return cmd("alarm_os_schedule", { id, title: title.slice(0, 120), dueAtMs: Math.round(dueAt) + OS_GRACE_MS })
    .then(() => true)
    .catch(() => false);
}

export async function cancelOsAlarm(id: string): Promise<void> {
  if (!isTauri()) return;
  await cmd("alarm_os_cancel", { id }).catch(() => undefined);
}

/** Startup cleanup: drop OS alarms whose reminder is gone, fired or dismissed. */
export async function pruneOsAlarms(liveIds: string[]): Promise<void> {
  if (!isTauri()) return;
  await cmd("alarm_os_prune", { liveIds }).catch(() => undefined);
}

/** Alarms saved while the gateway was down live only in Task Scheduler: keep them through `pruneOsAlarms`. */
const LOCAL_KEY = "cc.osAlarms.local";

function readLocal(): { id: string; dueAt: number }[] {
  try {
    const v = JSON.parse(localStorage.getItem(LOCAL_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x?.id === "string" && typeof x?.dueAt === "number") : [];
  } catch {
    return [];
  }
}

export function rememberLocalAlarm(id: string, dueAt: number) {
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify([...readLocal().filter((x) => x.dueAt > Date.now()), { id, dueAt }].slice(-200)));
  } catch {
    // storage unavailable: the alarm still rings, a later prune may drop it
  }
}

/** Ids of this-PC-only alarms that are still ahead. */
export const localAlarmIds = () => readLocal().filter((x) => x.dueAt > Date.now()).map((x) => x.id);
