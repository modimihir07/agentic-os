import { useSettings } from "@/stores/settings";
import { collections } from "@/lib/cc-api";
import { formatWhen, parseWhen, stripPhrases } from "./when";
import type { Reminder } from "./types";

/**
 * Voice/typed intents that only touch the local store:
 *   "remind me to call Sam in 20 minutes"
 *   "set an alarm for 6:45am"
 *   "countdown to my audition on March 14"
 *   "wake me up at 7 tomorrow"
 * Returns null when the text isn't one of these (→ normal dispatcher).
 */
export async function handleLocalIntent(text: string): Promise<{ reply: string; meta: string } | null> {
  const name = (useSettings.getState().osName || "Tony").toLowerCase().replace(/[^a-z0-9 ]/g, "");
  const t = text.trim().replace(new RegExp(`^(hey |ok |okay |yo )?((?:${name}|jarvis)[,]?\\s*)?(please\\s+|can you\\s+|could you\\s+)?`, "i"), "");
  const s = t.toLowerCase();

  const isAlarm = /^(set (an? |my )?alarm|alarm|wake me( up)?)\b/.test(s);
  const isReminder = /^remind me\b|^set (a )?reminder\b|^reminder\b/.test(s);
  const isCountdown = /^(start |set |add |make )?(a )?countdown\b/.test(s);
  if (!isAlarm && !isReminder && !isCountdown) return null;

  const when = parseWhen(t);
  if (!when) {
    return { reply: "When should that be? Try “in 20 minutes”, “at 7:30pm”, or “on Friday at 6”.", meta: "local · reminder (no time)" };
  }

  let title = stripPhrases(t, when.matched)
    .replace(/^(set (an? |my )?alarm( for)?|alarm( for)?|wake me( up)?|remind me( to| about| that)?|set (a )?reminder( to| for)?|reminder( to| for)?|(start |set |add |make )?(a )?countdown( to| until| for)?)\s*/i, "")
    .replace(/^(to|for|about|at|on)\s+/i, "")
    .replace(/[.!?]+$/, "")
    .trim();
  if (!title) title = isAlarm ? "Alarm" : isCountdown ? "Countdown" : "Reminder";
  title = title.charAt(0).toUpperCase() + title.slice(1);

  const kind: Reminder["kind"] = isAlarm ? "alarm" : isCountdown ? "countdown" : "reminder";
  await collections.create<Reminder>("reminders", { title, kind, dueAt: when.at.getTime(), source: "local", repeat: "none" });

  const whenText = formatWhen(when.at.getTime());
  const reply =
    kind === "alarm" ? `Alarm set for ${whenText}.` : kind === "countdown" ? `Counting down to ${title}, ${whenText}.` : `I'll remind you to ${title.charAt(0).toLowerCase() + title.slice(1)} ${whenText}.`;
  return { reply, meta: `local · ${kind} · saved to the shared store` };
}
