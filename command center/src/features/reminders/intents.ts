import { collections } from "@/lib/cc-api";
import { stripFiller } from "@/features/orchestrator/plan";
import { formatWhen, parseWhen, stripPhrases } from "./when";
import { rememberLocalAlarm, scheduleOsAlarm } from "./os-alarm";
import type { Reminder } from "./types";

/**
 * Voice/typed intents that only touch the local store:
 *   "remind me to call Sam in 20 minutes"
 *   "set an alarm for 6:45am"
 *   "set a timer for 10 minutes" / "10 minute timer"
 *   "countdown to my audition on March 14"
 *   "wake me up at 7 tomorrow"
 * Returns null when the text isn't one of these (→ normal dispatcher).
 * Alarms and reminders also get a Windows OS alarm (os-alarm.ts) that rings with the app closed.
 */
export async function handleLocalIntent(text: string): Promise<{ reply: string; meta: string } | null> {
  // "aye tony, can you …" / "hey, …": interjection, name and politeness dropped (shared with the planner).
  const t = stripFiller(text);
  const s = t.toLowerCase();

  const isTimer = /^((set|start) (me )?(a |an )?([\w.]+[- ]?(minutes?|mins?|seconds?|secs?|hours?|hrs?) )?timer\b|timer\b|(a |an )?[\w.]+[- ]?(minutes?|mins?|seconds?|secs?|hours?|hrs?) timer\b)/.test(s);
  const isAlarm = !isTimer && /^(set (an? |my )?alarm|alarm|wake me( up)?)\b/.test(s);
  const isReminder = /^remind me\b|^set (a )?reminder\b|^reminder\b/.test(s);
  const isCountdown = /^(start |set |add |make )?(a )?countdown\b/.test(s);
  if (!isTimer && !isAlarm && !isReminder && !isCountdown) return null;

  const now = new Date();
  const when = parseWhen(t, now, { duration: isTimer });
  if (!when) {
    const reply = isTimer ? "How long? Try “set a timer for 10 minutes”." : "When should that be? Try “in 20 minutes”, “at 7:30pm”, or “on Friday at 6”.";
    return { reply, meta: `local · ${isTimer ? "timer" : "reminder"} (no time)` };
  }

  let title = isTimer
    ? "Timer"
    : stripPhrases(t, when.matched)
        .replace(/^(set (an? |my )?alarm( for)?|alarm( for)?|wake me( up)?|remind me( to| about| that)?|set (a )?reminder( to| for)?|reminder( to| for)?|(start |set |add |make )?(a )?countdown( to| until| for)?)\s*/i, "")
        .replace(/^(to|for|about|at|on)\s+/i, "")
        .replace(/[.!?]+$/, "")
        .trim();
  if (!title) title = isAlarm ? "Alarm" : isCountdown ? "Countdown" : "Reminder";
  title = title.charAt(0).toUpperCase() + title.slice(1);

  const kind: Reminder["kind"] = isTimer || isAlarm ? "alarm" : isCountdown ? "countdown" : "reminder";
  const dueAt = when.at.getTime();
  const rings = kind !== "countdown";
  let saved: { id: string } | null = null;
  let saveError: unknown = null;
  try {
    saved = await collections.create<Reminder>("reminders", { title, kind, dueAt, source: "local", repeat: "none" });
  } catch (e) {
    saveError = e;
  }
  // Best effort: the Windows alarm rings even with the app closed (the in-app scheduler
  // cancels it when it fires first). Gateway down: it is the only alarm, kept through prunes.
  let osOnly = false;
  if (rings) {
    const id = saved?.id ?? `local-${crypto.randomUUID()}`;
    const ok = await scheduleOsAlarm(id, title, dueAt);
    if (!saved && ok) {
      rememberLocalAlarm(id, dueAt);
      osOnly = true;
    }
  }
  if (!saved && !osOnly) throw saveError;

  const whenText = isTimer ? `${durationText(dueAt - now.getTime())} (${formatWhen(dueAt)})` : formatWhen(dueAt);
  const what = isTimer ? "Timer" : kind === "alarm" ? "Alarm" : "Reminder";
  if (osOnly) return { reply: `${what} set for ${whenText} (this PC only).`, meta: `local · ${kind} · Windows alarm only (gateway unreachable)` };
  const reply =
    kind === "alarm"
      ? `${what} set for ${whenText}.`
      : kind === "countdown"
        ? `Counting down to ${title}, ${whenText}.`
        : `I'll remind you to ${title.charAt(0).toLowerCase() + title.slice(1)} ${whenText}.`;
  return { reply, meta: `local · ${isTimer ? "timer" : kind} · saved to the shared store` };
}

/** 600 000 → "10 minutes", 5 400 000 → "1 hour 30 minutes", 90 000 → "1 minute 30 seconds". */
export function durationText(ms: number): string {
  const total = Math.max(1, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  const part = (n: number, unit: string) => (n ? `${n} ${unit}${n === 1 ? "" : "s"}` : "");
  return [part(h, "hour"), part(m, "minute"), h ? "" : part(sec, "second")].filter(Boolean).join(" ") || "a moment";
}
