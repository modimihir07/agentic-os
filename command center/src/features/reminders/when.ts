/**
 * Tiny natural-language time parser for voice reminders. Offline, no deps.
 *
 *   "in 20 minutes", "in an hour", "in 3 days"
 *   "at 7", "at 7:30pm", "at noon", "tonight", "tomorrow at 9am"
 *   "on friday at 6", "next monday", "on March 14", "on 2026-12-24 at 10"
 *   timers only (`duration`): "for 10 minutes", "a 10 minute timer"
 *
 * Returns the resolved time and the exact substring it consumed so the
 * caller can strip it from the title.
 */
const WORDNUM: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, fifteen: 15, twenty: 20, thirty: 30, "forty-five": 45, half: 0.5 };
const UNIT_MS: Record<string, number> = { s: 1000, sec: 1000, second: 1000, m: 60_000, min: 60_000, minute: 60_000, h: 3_600_000, hr: 3_600_000, hour: 3_600_000, d: 86_400_000, day: 86_400_000, w: 604_800_000, week: 604_800_000 };
const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

export interface When {
  at: Date;
  matched: string[];
  /** True when the user said a clock time (so all-day defaults weren't used). */
  hasTime: boolean;
}

function parseClock(s: string): { h: number; m: number; matched: string } | null {
  const noon = s.match(/\b(at )?(noon|midday)\b/i);
  if (noon) return { h: 12, m: 0, matched: noon[0] };
  const mid = s.match(/\b(at )?midnight\b/i);
  if (mid) return { h: 0, m: 0, matched: mid[0] };
  // Whisper transcribes "six forty five" as "6.45", so accept ":" or "." between hours and minutes.
  const r =
    s.match(/\b(?:at|@|by|for)\s+(\d{1,2})(?:[:.](\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?(?=\W|$)/i) ??
    s.match(/\b(\d{1,2})(?:[:.](\d{2}))?\s*(a\.?m\.?|p\.?m\.?)(?=\W|$)/i) ??
    s.match(/\b(\d{1,2})[:.](\d{2})()(?=\W|$)/);
  if (!r) return null;
  let h = Number(r[1]);
  const m = Number(r[2] ?? 0);
  // "…in the morning / tonight / this evening" stand in for am / pm.
  const ap = r[3]?.toLowerCase().replace(/\./g, "") || (/\bmorning\b/.test(s) ? "am" : /\b(evening|tonight|afternoon)\b/.test(s) && h < 12 ? "pm" : undefined);
  // "for 3 people" / "for 2 days" are not times: only accept a bare "for N" with minutes or am/pm.
  if (/^for\s/i.test(r[0]) && !r[2] && !r[3]) return null;
  if (h > 23 || m > 59) return null;
  if (ap === "pm" && h < 12) h += 12;
  if (ap === "am" && h === 12) h = 0;
  // "at 7" with no am/pm: assume the next upcoming 7 (handled by the caller via `ambiguous`).
  return { h, m, matched: r[0] };
}

/** Timers only: "for 10 minutes", "10 minute", "10-minute", "an hour" — no "in" needed. */
const DURATION_RE =
  /\b(?:(?:in|for)\s+)?(\d+(?:\.\d+)?|a|an|one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|thirty|forty-five|half an?)\s*-?\s*(seconds?|secs?|minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w)\b(\s+and a half)?/;

/** `duration`: the line is a timer, so a bare length ("for 10 minutes") counts from now. */
export function parseWhen(text: string, now = new Date(), opts: { duration?: boolean } = {}): When | null {
  const s = text.toLowerCase();
  const matched: string[] = [];

  // Relative: "in 20 minutes", "in an hour and a half"
  const rel = opts.duration
    ? s.match(DURATION_RE)
    : s.match(/\bin\s+(\d+(?:\.\d+)?|a|an|one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|thirty|forty-five|half an?)\s*(seconds?|secs?|minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w)\b(\s+and a half)?/);
  if (rel) {
    const n = rel[1].startsWith("half") ? 0.5 : (WORDNUM[rel[1]] ?? Number(rel[1]));
    const unit = rel[2].replace(/s$/, "");
    const ms = (UNIT_MS[unit] ?? UNIT_MS[unit.replace(/s$/, "")]) * (n + (rel[3] ? 0.5 : 0));
    if (ms) return { at: new Date(now.getTime() + ms), matched: [rel[0]], hasTime: true };
  }

  const at = new Date(now);
  let dayChosen = false;

  // Explicit date: ISO, "march 14", "14 march"
  const iso = s.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  const md = s.match(new RegExp(`\\b(?:on\\s+)?(${MONTHS.join("|")})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?`));
  const dm = s.match(new RegExp(`\\b(?:on\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTHS.join("|")})(?:\\s+(\\d{4}))?`));
  if (iso) {
    at.setFullYear(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
    matched.push(`on ${iso[0]}`, iso[0]);
    dayChosen = true;
  } else if (md || dm) {
    const [mon, day, yr] = md ? [md[1], md[2], md[3]] : [dm![2], dm![1], dm![3]];
    at.setMonth(MONTHS.indexOf(mon), Number(day));
    if (yr) at.setFullYear(Number(yr));
    else if (at.getTime() < now.getTime() - 86_400_000) at.setFullYear(at.getFullYear() + 1);
    matched.push((md ?? dm)![0]);
    dayChosen = true;
  }

  // Relative days
  const tom = s.match(/\btomorrow\b/);
  const tonight = s.match(/\btonight\b|\bthis evening\b/);
  const wd = s.match(new RegExp(`\\b(?:on\\s+|next\\s+|this\\s+)?(${DAYS.join("|")})\\b`));
  if (!dayChosen && tom) {
    at.setDate(at.getDate() + 1);
    matched.push(tom[0]);
    dayChosen = true;
  } else if (!dayChosen && wd) {
    const target = DAYS.indexOf(wd[1]);
    let delta = (target - now.getDay() + 7) % 7;
    if (delta === 0 || wd[0].startsWith("next")) delta = delta === 0 ? 7 : delta;
    at.setDate(at.getDate() + delta);
    matched.push(wd[0]);
    dayChosen = true;
  }

  const clock = parseClock(s);
  if (clock) {
    at.setHours(clock.h, clock.m, 0, 0);
    matched.push(clock.matched);
    // "at 7" (no am/pm) already passed today → the next 7 o'clock (pm first).
    if (!dayChosen && at <= now) {
      const noMeridiem = !/[ap]\.?m/i.test(clock.matched) && clock.h < 12;
      if (noMeridiem && clock.h + 12 > now.getHours()) at.setHours(clock.h + 12);
      else at.setDate(at.getDate() + 1);
    }
    return { at, matched, hasTime: true };
  }
  if (tonight) {
    at.setHours(20, 0, 0, 0);
    if (at <= now) at.setTime(now.getTime() + 3_600_000);
    return { at, matched: [...matched, tonight[0]], hasTime: true };
  }
  if (dayChosen) {
    at.setHours(9, 0, 0, 0);
    return { at, matched, hasTime: false };
  }
  return null;
}

export function stripPhrases(text: string, phrases: string[]): string {
  let out = text;
  for (const p of phrases.sort((a, b) => b.length - a.length)) {
    out = out.replace(new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"), " ");
  }
  return out.replace(/\s{2,}/g, " ").replace(/\s+([,.!?])/g, "$1").trim();
}

export function formatWhen(ms: number, now = Date.now()): string {
  const d = new Date(ms);
  const sameDay = new Date(now).toDateString() === d.toDateString();
  const tomorrow = new Date(now + 86_400_000).toDateString() === d.toDateString();
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (sameDay) return `today at ${time}`;
  if (tomorrow) return `tomorrow at ${time}`;
  const within7 = ms - now < 6 * 86_400_000 && ms > now;
  return `${d.toLocaleDateString([], within7 ? { weekday: "long" } : { month: "short", day: "numeric" })} at ${time}`;
}

export function countdown(ms: number, now = Date.now()): string {
  const diff = ms - now;
  if (diff <= 0) return "now";
  const d = Math.floor(diff / 86_400_000);
  const h = Math.floor((diff % 86_400_000) / 3_600_000);
  const m = Math.floor((diff % 3_600_000) / 60_000);
  if (d >= 2) return `${d}d ${h}h`;
  if (d === 1) return `1d ${h}h`;
  if (h) return `${h}h ${m}m`;
  const s = Math.floor((diff % 60_000) / 1000);
  return m ? `${m}m ${s}s` : `${s}s`;
}
