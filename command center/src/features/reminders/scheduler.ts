import { useEffect } from "react";
import { collections, useCollection } from "@/lib/cc-api";
import { cmd, isTauri, platform } from "@/lib/platform";
import { announce } from "@/features/voice/voice-controller";
import { chime, systemNotify, useToasts } from "./notify";
import { nextOccurrence, type Reminder } from "./types";

const DEVICE = `${platform}-${(crypto.randomUUID?.() ?? Math.random().toString(36)).slice(0, 6)}`;
const FIRE_WINDOW_MS = 10 * 60_000; // don't fire stale alarms after a device was offline for hours

/**
 * Mounted once at the app root. Every 10 s it fires due reminders on THIS
 * device (whichever device is open), then marks them fired in the shared
 * store so the phone and desktop don't both ring. Repeating reminders roll
 * forward. On desktop it also mirrors Google Calendar through n8n.
 */
export function useReminderScheduler() {
  const { items } = useCollection<Reminder>("reminders"); // keeps the collection syncing

  useEffect(() => {
    const tick = () => {
      const now = Date.now();
      for (const r of collections.snapshot<Reminder>("reminders")) {
        if (r.kind === "countdown" || r.dismissed || r.firedAt || r.dueAt > now) continue;
        if (now - r.dueAt > FIRE_WINDOW_MS) {
          void collections.update<Reminder>("reminders", r.id, { firedAt: now, firedBy: `${DEVICE} (missed)` });
          continue;
        }
        void fire(r);
      }
    };
    const t = setInterval(tick, 10_000);
    tick();
    return () => clearInterval(t);
  }, []);

  // Google Calendar mirror (desktop, via a read-only n8n workflow).
  useEffect(() => {
    if (!isTauri()) return;
    const run = () => void syncCalendar().catch(() => undefined);
    run();
    const t = setInterval(run, 10 * 60_000);
    return () => clearInterval(t);
  }, []);

  return items;
}

async function fire(r: Reminder & { id: string }) {
  const next = nextOccurrence(r);
  // Claim it first so another device doesn't fire it too.
  await collections.update<Reminder>("reminders", r.id, next ? { dueAt: next, firedAt: null, firedBy: DEVICE } : { firedAt: Date.now(), firedBy: DEVICE });

  const label = r.kind === "alarm" ? "Alarm" : r.kind === "event" ? "Upcoming" : "Reminder";
  void chime(r.kind === "alarm" ? 3 : 2);
  void systemNotify(`${label}: ${r.title}`, r.notes ?? "");
  const id = useToasts.getState().push({
    title: `${label}: ${r.title}`,
    body: r.notes,
    tone: "alarm",
    actions: [
      {
        label: "Snooze 5 min",
        run: () => {
          void collections.update<Reminder>("reminders", r.id, { dueAt: Date.now() + 5 * 60_000, firedAt: null });
          useToasts.getState().dismiss(id);
        },
      },
      { label: "Dismiss", run: () => useToasts.getState().dismiss(id) },
    ],
  });
  void announce(`${label}. ${r.title}.`);
}

interface GcalEvent {
  id: string;
  summary?: string;
  title?: string;
  start?: string | { dateTime?: string; date?: string };
  description?: string;
}

/**
 * Pull upcoming events from n8n's "calendar-upcoming" workflow (n8n holds the
 * Google OAuth) into the shared reminders collection. Read-only: Rust refuses
 * n8n_fetch on any workflow not marked `mutating: false`.
 */
export async function syncCalendar(): Promise<number> {
  const wfs = await cmd("n8n_workflows");
  if (!wfs.some((w) => w.name === "calendar-upcoming" && !w.mutating)) return 0;
  const out = (await cmd("n8n_fetch", { name: "calendar-upcoming" })) as GcalEvent[] | { events?: GcalEvent[]; items?: GcalEvent[] };
  const events = Array.isArray(out) ? out : (out.events ?? out.items ?? []);
  const existing = new Map(collections.snapshot<Reminder>("reminders").filter((r) => r.gcalId).map((r) => [r.gcalId!, r]));
  let n = 0;
  for (const e of events.slice(0, 200)) {
    const startRaw = typeof e.start === "string" ? e.start : (e.start?.dateTime ?? e.start?.date);
    const dueAt = startRaw ? Date.parse(startRaw) : NaN;
    if (!e.id || Number.isNaN(dueAt)) continue;
    const data = { title: e.summary ?? e.title ?? "(untitled)", dueAt, notes: e.description?.slice(0, 500), kind: "event" as const, source: "gcal" as const, gcalId: e.id, repeat: "none" as const };
    const prev = existing.get(e.id);
    if (!prev) {
      await collections.create<Reminder>("reminders", data);
      n++;
    } else if (prev.dueAt !== dueAt || prev.title !== data.title) {
      await collections.update<Reminder>("reminders", prev.id, { ...data, firedAt: prev.dueAt === dueAt ? prev.firedAt : null });
      n++;
    }
  }
  return n;
}
