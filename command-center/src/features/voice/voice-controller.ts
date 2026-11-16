import type { AgentRole } from "@/features/dispatcher/agents";
import { execute } from "@/features/orchestrator/execute";
import { parseConfirmation, planIntent } from "@/features/orchestrator/plan";
import type { ChatMessage } from "@/lib/platform";
import { useSettings } from "@/stores/settings";
import { createEngines } from "./engines";
import { useVoice, type Channel } from "./voice-store";

/**
 * Conversation state machine (voice-first; text uses the same path):
 *
 *   listen → transcribe → plan (+verify)
 *        ├─ read-only → execute → speak reply
 *        └─ mutating  → CONFIRM card + spoken read-back → listen for yes/no
 *                         ├─ yes / tap Approve → execute → speak result
 *                         ├─ no / tap Cancel / Esc → cancelled, nothing sent
 *                         ├─ unclear → re-prompt once, then cancel
 *                         └─ timeout → cancelled (fails closed)
 *
 * Module-level singletons so a session survives navigation.
 */
const { stt, tts } = createEngines();
let confirmTimer: ReturnType<typeof setTimeout> | undefined;

export const voiceCaps = {
  stt: !!stt,
  sttName: stt?.name ?? "typed input",
  get ttsName() {
    return tts.name;
  },
};

const store = () => useVoice.getState();

const history = (): ChatMessage[] =>
  store()
    .turns.filter((t) => t.who !== "system")
    .slice(-8)
    .map((t) => ({ role: t.who === "user" ? "user" : "assistant", content: t.text }));

async function say(text: string) {
  if (!tts.supported || !text) return;
  try {
    await tts.speak(text);
  } catch {
    /* speech is best-effort; the text is on screen */
  }
}

// ── Listening ───────────────────────────────────────────────────────────────

export function startListening(opts: { forConfirmation?: boolean } = {}) {
  const v = store();
  tts.cancel();
  v.setExpanded(true);
  v.setPartial("");
  if (!stt) {
    v.setError("Speech-to-text unavailable here — type below");
    return;
  }
  v.setState("listening");
  stt.start(
    {
      onPartial: (t) => store().setPartial(t),
      onPhase: (p) => p === "transcribing" && store().setState("transcribing"),
      onFinal: (t) => {
        store().setPartial("");
        if (t) return void handleInput(t, { channel: "voice" });
        // Silence: back to the right resting state.
        store().setState(store().pending ? "confirming" : "idle");
      },
      onError: (e) => {
        const p = store().pending;
        store().setError(e);
        if (p) store().setState("confirming"); // keep the card; tap still works
      },
    },
    { maxSilenceStartMs: opts.forConfirmation ? 8000 : 7000 },
  );
}

/** Mic button while listening: stop and use what was said so far. */
export function finishListening() {
  stt?.stop();
}

/** Esc / close: stop everything. A pending action is cancelled (fail closed). */
export function stopVoice() {
  stt?.abort();
  tts.cancel();
  if (store().pending) return reject("stopped");
  store().setState("idle");
}

export function toggleListening() {
  const s = store().state;
  if (s === "listening") finishListening();
  else if (s === "speaking") stopVoice();
  else if (s === "idle" || s === "error" || s === "confirming") startListening({ forConfirmation: s === "confirming" });
}

// ── Input handling ──────────────────────────────────────────────────────────

export async function handleInput(text: string, opts: { channel: Channel; role?: AgentRole }) {
  const v = store();
  const t = text.trim();
  if (!t) return;
  if (v.pending) return answerConfirmation(t, opts.channel);

  v.pushTurn({ who: "user", text: t });
  v.setState("thinking");
  let plan;
  try {
    plan = await planIntent(t, { role: opts.role, history: history().slice(0, -1) });
  } catch (e) {
    return fail(e);
  }

  if (!plan.mutating) return run(plan, opts.channel);

  const timeoutSec = useSettings.getState().confirmTimeoutSec;
  v.setPending({ plan, channel: opts.channel, deadline: Date.now() + timeoutSec * 1000, reprompted: false });
  v.setState("confirming");
  clearTimeout(confirmTimer);
  confirmTimer = setTimeout(() => reject("timed out"), timeoutSec * 1000);

  if (opts.channel === "voice") {
    await say(plan.readBack);
    // Only listen if this same plan is still waiting (user may have tapped meanwhile).
    if (store().pending?.plan.id === plan.id) startListening({ forConfirmation: true });
  }
}

async function answerConfirmation(reply: string, channel: Channel) {
  const p = store().pending!;
  store().pushTurn({ who: "user", text: reply });
  const verdict = parseConfirmation(reply);
  if (verdict === "yes") return approve(channel === "voice" ? "voice" : "typed");
  if (verdict === "no") return reject("declined");
  if (p.reprompted) return reject("reply unclear");
  store().setPending({ ...p, reprompted: true });
  store().setState("confirming");
  if (channel === "voice") {
    await say("Say yes to proceed, or no to cancel.");
    if (store().pending?.plan.id === p.plan.id) startListening({ forConfirmation: true });
  }
}

/** The ONLY path by which a mutating plan reaches an executor. */
export async function approve(via: "voice" | "tap" | "typed") {
  const p = store().pending;
  if (!p) return;
  clearTimeout(confirmTimer);
  stt?.abort();
  tts.cancel();
  store().setPending(null);
  store().pushTurn({ who: "system", text: `Approved (${via}): ${p.plan.summary}`, tone: "ok" });
  await run(p.plan, p.channel);
}

export function reject(reason: string) {
  const p = store().pending;
  if (!p) return;
  clearTimeout(confirmTimer);
  stt?.abort();
  store().setPending(null);
  store().pushTurn({ who: "system", text: `Cancelled (${reason}) — nothing was sent.`, tone: "warn" });
  store().setState("idle");
  if (p.channel === "voice") void say("Cancelled.");
}

async function run(plan: Parameters<typeof execute>[0], channel: Channel) {
  store().setState("thinking");
  try {
    const r = await execute(plan, history().slice(0, -1));
    store().pushTurn({ who: "agent", text: r.text, role: plan.role, meta: r.meta });
    if (channel === "voice") {
      store().setState("speaking");
      await say(r.text);
    }
    if (store().state === "speaking" || store().state === "thinking") store().setState("idle");
  } catch (e) {
    fail(e);
  }
}

function fail(e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  store().pushTurn({ who: "system", text: msg, tone: "error" });
  store().setError(msg);
}
