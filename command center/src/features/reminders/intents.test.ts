import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const create = vi.fn();
const scheduleOsAlarm = vi.fn();
const rememberLocalAlarm = vi.fn();
vi.mock("@/lib/cc-api", () => ({ collections: { create: (...a: unknown[]) => create(...a) } }));
vi.mock("./os-alarm", () => ({ scheduleOsAlarm: (...a: unknown[]) => scheduleOsAlarm(...a), rememberLocalAlarm: (...a: unknown[]) => rememberLocalAlarm(...a) }));

const { durationText, handleLocalIntent } = await import("./intents");
const { parseWhen } = await import("./when");

const NOW = new Date(2026, 10, 18, 14, 0, 0);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  create.mockReset().mockImplementation(async (_c: string, data: object) => ({ id: "rem-1", ...data }));
  scheduleOsAlarm.mockReset().mockResolvedValue(true);
  rememberLocalAlarm.mockReset();
});
afterEach(() => vi.useRealTimers());

describe("handleLocalIntent — timers and alarms, no card", () => {
  it("'aye tony set a timer for 10 minutes' → a 10-minute alarm plus the Windows alarm", async () => {
    const r = await handleLocalIntent("aye tony set a timer for 10 minutes");
    expect(r?.reply).toMatch(/^Timer set for 10 minutes \(/);
    const [, data] = create.mock.calls[0];
    expect(data).toMatchObject({ title: "Timer", kind: "alarm", dueAt: NOW.getTime() + 600_000 });
    expect(scheduleOsAlarm).toHaveBeenCalledWith("rem-1", "Timer", NOW.getTime() + 600_000);
  });

  it.each(["10 minute timer", "Hey Tony, set a 10-minute timer", "ok start a timer for ten minutes", "hi tony can you set me a timer for 10 mins"])("%s", async (line) => {
    await handleLocalIntent(line);
    expect(create.mock.calls[0][1]).toMatchObject({ kind: "alarm", title: "Timer", dueAt: NOW.getTime() + 600_000 });
  });

  it("a timer without a length asks how long and saves nothing", async () => {
    const r = await handleLocalIntent("start a timer");
    expect(r?.reply).toMatch(/How long/);
    expect(create).not.toHaveBeenCalled();
  });

  it.each(["set an alarm for 7 PM", "aye tony, set an alarm for 7 PM", "yo tony alarm at 7pm", "oi Tony, wake me up at 7pm"])("%s → 7 PM today", async (line) => {
    const r = await handleLocalIntent(line);
    expect(r?.reply).toMatch(/^Alarm set for today at/);
    expect(create.mock.calls[0][1]).toMatchObject({ kind: "alarm", dueAt: new Date(2026, 10, 18, 19, 0, 0).getTime() });
  });

  it("'for N minutes' is a length only for timers: an alarm 'for 10 minutes' asks when", async () => {
    const r = await handleLocalIntent("set an alarm for 10 minutes");
    expect(r?.reply).toMatch(/When should that be/);
  });

  it("reminders get the Windows alarm too; countdowns don't", async () => {
    await handleLocalIntent("remind me to call Sam in 20 minutes");
    expect(scheduleOsAlarm).toHaveBeenCalledWith("rem-1", "Call Sam", NOW.getTime() + 1_200_000);
    scheduleOsAlarm.mockClear();
    await handleLocalIntent("countdown to my audition on March 14");
    expect(scheduleOsAlarm).not.toHaveBeenCalled();
  });

  it("gateway down: the Windows alarm still rings — 'this PC only'", async () => {
    create.mockRejectedValue(new Error("gateway unreachable"));
    const r = await handleLocalIntent("set an alarm for 7 PM");
    expect(r?.reply).toMatch(/\(this PC only\)\.$/);
    const [id] = scheduleOsAlarm.mock.calls[0];
    expect(id).toMatch(/^local-[A-Za-z0-9-]+$/);
    expect(rememberLocalAlarm).toHaveBeenCalledWith(id, new Date(2026, 10, 18, 19, 0, 0).getTime());
  });

  it("gateway down and no Windows alarm: the save error surfaces", async () => {
    create.mockRejectedValue(new Error("gateway unreachable"));
    scheduleOsAlarm.mockResolvedValue(false);
    await expect(handleLocalIntent("set an alarm for 7 PM")).rejects.toThrow(/gateway unreachable/);
  });

  it("other lines are not local intents", async () => {
    expect(await handleLocalIntent("any whatsapp updates?")).toBeNull();
    expect(await handleLocalIntent("set the meeting for Friday")).toBeNull();
  });
});

describe("parseWhen duration mode", () => {
  it("only reads a bare length when asked", () => {
    expect(parseWhen("timer for 90 seconds", NOW, { duration: true })?.at.getTime()).toBe(NOW.getTime() + 90_000);
    expect(parseWhen("an hour timer", NOW, { duration: true })?.at.getTime()).toBe(NOW.getTime() + 3_600_000);
    expect(parseWhen("alarm for 10 minutes", NOW)).toBeNull();
    expect(parseWhen("in 10 minutes", NOW)?.at.getTime()).toBe(NOW.getTime() + 600_000);
  });

  it("durationText reads naturally", () => {
    expect(durationText(600_000)).toBe("10 minutes");
    expect(durationText(5_400_000)).toBe("1 hour 30 minutes");
    expect(durationText(90_000)).toBe("1 minute 30 seconds");
    expect(durationText(1_000)).toBe("1 second");
  });
});
