export interface Reminder {
  title: string;
  kind: "alarm" | "reminder" | "countdown" | "event";
  /** Epoch ms. */
  dueAt: number;
  repeat: "none" | "daily" | "weekdays" | "weekly" | "monthly";
  source: "local" | "gcal";
  /** Google Calendar event id when mirrored from / pushed to Calendar. */
  gcalId?: string;
  notes?: string;
  /** null (not undefined) to clear — undefined is dropped by JSON and would never reach the server. */
  firedAt?: number | null;
  firedBy?: string;
  dismissed?: boolean;
}

export const REPEAT_MS: Record<Exclude<Reminder["repeat"], "none" | "monthly" | "weekdays">, number> = {
  daily: 86_400_000,
  weekly: 7 * 86_400_000,
};

/** Next occurrence after `from` for a repeating reminder. */
export function nextOccurrence(r: Reminder, from = Date.now()): number | null {
  if (r.repeat === "none") return null;
  let t = r.dueAt;
  const d = new Date(t);
  for (let i = 0; i < 400 && t <= from; i++) {
    if (r.repeat === "monthly") {
      d.setMonth(d.getMonth() + 1);
      t = d.getTime();
    } else if (r.repeat === "weekdays") {
      do {
        d.setDate(d.getDate() + 1);
      } while (d.getDay() === 0 || d.getDay() === 6);
      t = d.getTime();
    } else {
      t += REPEAT_MS[r.repeat];
      d.setTime(t);
    }
  }
  return t;
}
