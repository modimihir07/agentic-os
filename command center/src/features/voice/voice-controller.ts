import { SUB_AGENTS, type AgentRole } from "@/features/dispatcher/agents";
import { execute } from "@/features/orchestrator/execute";
import { parseConfirmation, planIntent, stripWake, type ActionPlan } from "@/features/orchestrator/plan";
import { handleLocalIntent } from "@/features/reminders/intents";
import { gated } from "@/features/bridge/gate";
import { liveContext } from "@/features/os/context";
import { useOs } from "@/features/os/os-store";
import { runPipeline, usePipelines } from "@/features/os/pipeline-store";
import { fireCue, isStopCue, matchCue, registerCueIO } from "@/features/cues/cue-runtime";
import { useCueRun } from "@/features/cues/player";
import { cc } from "@/lib/cc-api";
import { cmd, isTauri, onNativeEvent, type ChatMessage, type OsTurnResult } from "@/lib/platform";
import { useSettings } from "@/stores/settings";
import { createEngines } from "./engines";
import { useVoice, type Channel, type ThreadId, type VoiceTurn } from "./voice-store";

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

/** The active thread's conversation (isolated per Dispatcher tab). */
const history = (thread: ThreadId = store().activeThread): ChatMessage[] =>
  store()
    .turns.filter((t) => t.thread === thread && (t.who === "user" || t.who === "agent"))
    .slice(-8)
    .map((t) => ({ role: t.who === "user" ? "user" : "assistant", content: t.text }));

async function say(text: string, voice?: string) {
  if (!tts.supported || !text || convo.barged) return;
  try {
    await tts.speak(text, voice);
  } catch {
    /* speech is best-effort; the text is on screen */
  }
}

// ── Conversation: barge-in while Tony talks, follow-up listening after ─────
//
// While Tony is speaking a voice reply, the mic listens with a STRICTER trigger
// (echo cancellation removes most of his own voice; the offset covers the rest).
// If you start talking, he stops mid-sentence and your words are transcribed.
// When he finishes, the mic stays open for a few seconds for your follow-up —
// no wake word, no button.
const convo = { barged: false, active: false };

function speechHandlers(followUp: boolean) {
  return {
    onPartial: (t: string) => store().setPartial(t),
    onPhase: (p: string) => {
      if (p === "speech" && convo.active) {
        // Barge-in: you talked over Tony.
        convo.barged = true;
        convo.active = false;
        tts.cancel();
        store().setState("listening");
      }
      if (p === "transcribing") store().setState("transcribing");
    },
    onFinal: (t: string) => {
      convo.active = false;
      store().setPartial("");
      if (t) return void handleInput(t, { channel: "voice" });
      store().setState(store().pending ? "confirming" : "idle");
      if (!followUp) rearmWake();
      else rearmWake();
    },
    onError: (e: string) => {
      convo.active = false;
      store().setError(e);
    },
  };
}

/** Start listening for a barge-in while a voice reply plays. */
function startBargeIn() {
  const c = useSettings.getState().conversation;
  if (!c.bargeIn || !stt || convo.active || store().pending) return;
  convo.active = true;
  stt.start(speechHandlers(true), { maxSilenceStartMs: 120_000, sensitivityOffset: -25 });
}

/** Reply finished: hand over to a short follow-up window (or back to rest). */
function afterVoiceReply() {
  const c = useSettings.getState().conversation;
  if (convo.barged) return; // already capturing what you said over Tony
  if (convo.active) {
    convo.active = false;
    stt?.abort();
  }
  if (c.followUp && stt && !store().pending) {
    store().setState("listening");
    stt.start(speechHandlers(true), { maxSilenceStartMs: c.followUpSecs * 1000 });
  } else store().setState("idle");
}

// ── Listening ───────────────────────────────────────────────────────────────

export function startListening(opts: { forConfirmation?: boolean } = {}) {
  const v = store();
  convo.active = false;
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
        if (t && wake.armed && !opts.forConfirmation) {
          // Hands-free: only lines that start with a wake word ("Hey Tony…") count.
          const cmdText = useSettings.getState().wakeRequire ? afterWakeWord(t) : t;
          if (cmdText === null) {
            store().setState("idle");
            return void rearmWake();
          }
          if (!cmdText) {
            store().setState("idle");
            return void startListening();
          }
          return void handleInput(cmdText, { channel: "voice" }).finally(rearmWake);
        }
        if (t) return void handleInput(t, { channel: "voice" });
        // Silence: back to the right resting state.
        store().setState(store().pending ? "confirming" : "idle");
        rearmWake();
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
  convo.active = false;
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

  convo.barged = false;
  // The tab you're on is the thread this exchange lives in.
  const thread = v.activeThread;
  const role = opts.role ?? (thread !== "auto" ? (thread as AgentRole) : undefined);
  v.pushTurn({ who: "user", text: t, thread });

  // "Stop gabagool mode" (any spelling Whisper produces) — checked BEFORE starting cues,
  // since the phrase itself contains "gabagool mode".
  if (isStopCue(t)) {
    useCueRun.getState().stopAll();
    store().pushTurn({ who: "system", text: "Gabagool mode off.", tone: "ok", thread });
    store().setState("idle");
    if (opts.channel === "voice") void say("Alright, shutting it down.");
    return;
  }

  // Voice & Triggers: "enter gabagool mode" etc. run their cue widget.
  const cue = matchCue(t);
  if (cue) {
    store().setState("idle");
    fireCue(cue);
    return;
  }

  // Stage 2 trigger: "yeah, build that" right after an idea was offered.
  const offered = usePipelines.getState().offered;
  if (offered && offered.thread === thread && BUILD_YES.test(stripWake(t))) {
    store().setState("idle");
    void runPipeline(offered.ideaId, offered.title, thread);
    return;
  }
  // Stage 1: an idea for Tony (not a sub-agent tab) → Prompter breakdown + Librarian ledger.
  if (isTauri() && (thread === "auto" || thread === "general") && looksLikeIdea(t)) return captureIdea(t, thread, opts.channel);
  v.setState("thinking");

  // Local intents (alarms, reminders, countdowns) write only to this machine's
  // own store — nothing leaves it — so they don't need the confirmation card.
  const local = await handleLocalIntent(t).catch((e) => ({ reply: `Couldn't save that: ${e instanceof Error ? e.message : e}`, meta: "local" }));
  if (local) {
    v.pushTurn({ who: "agent", text: local.reply, meta: local.meta });
    if (opts.channel === "voice") {
      v.setState("speaking");
      await say(local.reply);
    }
    store().setState("idle");
    return;
  }

  let plan;
  try {
    plan = await planIntent(stripWake(t), { role, history: history(thread).slice(0, -1) });
  } catch (e) {
    return fail(e);
  }
  plan.thread = thread;
  plan.explicitRole = !!role && thread !== "auto";

  if (!plan.mutating) return run(plan, opts.channel);
  await requestConfirmation(plan, opts.channel);
}

/**
 * Put a mutating plan in front of the human: card + (for voice) a spoken
 * read-back, then listen for yes/no. Also used by features that build a plan
 * themselves (e.g. "Add to Google Calendar" on a reminder).
 */
export async function requestConfirmation(plan: ActionPlan, channel: Channel) {
  const v = store();
  if (v.pending) reject("superseded");
  const timeoutSec = useSettings.getState().confirmTimeoutSec;
  v.setPending({ plan, channel, deadline: Date.now() + timeoutSec * 1000, reprompted: false });
  v.setState("confirming");
  clearTimeout(confirmTimer);
  confirmTimer = setTimeout(() => reject("timed out"), timeoutSec * 1000);

  // Manual Overseer Mode: a second opinion lands on the card while you decide.
  const os = useOs.getState().cfg;
  if (os?.overseer.manualMode && isTauri() && plan.target.kind !== "bridge") void overseerReview(plan);

  if (channel === "voice") {
    await say(plan.readBack);
    // Only listen if this same plan is still waiting (user may have tapped meanwhile).
    if (store().pending?.plan.id === plan.id) startListening({ forConfirmation: true });
  }
}

async function overseerReview(plan: ActionPlan) {
  try {
    const r = await cmd("overseer_ask", {
      req: {
        question: `Before the user approves it, review this action in two sentences: is it what they asked for, and is anything risky or missing?\nRequest: "${plan.utterance}"\nPlan: ${plan.summary} ${JSON.stringify(plan.payload)}`,
        transcript: [],
        context: await liveContext(),
      },
    });
    const p = store().pending;
    if (p?.plan.id !== plan.id) return;
    const notes = [...p.plan.verification.notes, `Overseer (${r.engine}): ${r.answer.slice(0, 400)}`];
    store().setPending({ ...p, plan: { ...p.plan, verification: { ...p.plan.verification, notes } } });
  } catch {
    /* advisory only */
  }
}

/** Speak a line outside a conversation turn (alarms firing, brainstorm acks). */
export async function announce(text: string) {
  await say(text);
}

async function answerConfirmation(reply: string, channel: Channel) {
  const p = store().pending!;
  store().pushTurn({ who: "user", text: reply, thread: p.plan.thread });
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
  store().pushTurn({ who: "system", text: `Approved (${via}): ${p.plan.summary}`, tone: "ok", thread: p.plan.thread });
  await run(p.plan, p.channel);
}

export function reject(reason: string) {
  const p = store().pending;
  if (!p) return;
  clearTimeout(confirmTimer);
  stt?.abort();
  store().setPending(null);
  p.plan.onCancel?.();
  store().pushTurn({ who: "system", text: `Cancelled (${reason}) — nothing was sent.`, tone: "warn", thread: p.plan.thread });
  store().setState("idle");
  if (p.channel === "voice") void say("Cancelled.");
}

async function run(plan: Parameters<typeof execute>[0], channel: Channel) {
  store().setState("thinking");
  const thread = plan.thread ?? store().activeThread;
  // Read-only questions go through the OS core (context + sub-agents + tools).
  if (!plan.mutating && plan.target.kind === "agent" && !plan.run && isTauri()) return osRun(plan, channel, thread);
  try {
    const r = await execute(plan, history(thread).slice(0, -1));
    store().pushTurn({ who: "agent", text: r.text, role: plan.role, meta: r.meta, thread, from: "os" });
    if (channel === "voice") {
      store().setState("speaking");
      startBargeIn();
      await say(r.text);
      return afterVoiceReply();
    }
    if (store().state === "speaking" || store().state === "thinking") store().setState("idle");
  } catch (e) {
    fail(e);
  }
}

function fail(e: unknown, thread?: ThreadId) {
  const msg = e instanceof Error ? e.message : String(e);
  store().pushTurn({ who: "system", text: msg, tone: "error", thread });
  store().setError(msg);
}

// ── Idea-to-Execution (Stage 1) ─────────────────────────────────────────────

const IDEA = /\b(i'?ve been thinking (about|of)|i'?m thinking (about|of)|i (want|wanna|would like) to (build|make|create)|idea for (an?|my)? ?(app|tool|site|website|product|game|platform|service|plugin|widget)|what if (i|we) (built|made|created)|i have an idea|new idea:|app idea|business idea)\b/i;
const BUILD_YES = /^(yes|yeah|yep|yup|sure|ok(ay)?|do it|go( for it)?|build (it|that)|run (it|the pipeline)|spin (it|one) up|let'?s (do it|go|build))\b/i;
export const looksLikeIdea = (t: string) => IDEA.test(t);

async function captureIdea(text: string, thread: ThreadId, channel: Channel) {
  store().setState("thinking");
  try {
    const r = await cmd("idea_capture", { text });
    for (const s of r.steps) {
      store().pushTurn({ who: "relay", from: s.from, to: s.to, text: s.text, meta: s.kind, thread: s.to === "librarian" || s.from === "librarian" ? "librarian" : "prompter" });
    }
    const title = r.idea.title;
    usePipelines.getState().setOffered({ ideaId: r.idea.id, title, thread });
    store().pushTurn({ who: "agent", from: "os", text: r.reply, thread, link: "prompter", actions: [{ label: "Yes — run the pipeline", run: `pipeline:${r.idea.id}:${title}` }, { label: "Not now", run: "dismiss-offer" }] });
    if (channel === "voice") {
      store().setState("speaking");
      await say(r.reply);
      // Listen for "yeah, build that".
      if (store().state === "speaking") store().setState("idle");
      startListening();
    } else store().setState("idle");
  } catch (e) {
    fail(e, thread);
  }
}

/** One-tap answers rendered under a message. */
export function runTurnAction(run: string, thread: ThreadId) {
  if (run === "dismiss-offer") {
    usePipelines.getState().setOffered(null);
    return;
  }
  const m = /^pipeline:([^:]+):(.*)$/.exec(run);
  if (m) return void runPipeline(m[1], m[2], thread);
  // retry:<checkpoint>  ·  offload:<engine>:<checkpoint>
  const retry = /^retry:(.+)$/.exec(run);
  const offload = /^offload:([a-z-]+):(.+)$/.exec(run);
  if (retry || offload) {
    const checkpoint = (retry ?? offload)![retry ? 1 : 2];
    store().pushTurn({ who: "system", text: offload ? `Re-running the step on ${offload[1]}…` : "Retrying the step from its checkpoint…", tone: "ok", thread });
    void cmd("pipeline_resume", { checkpoint, offload: offload?.[1] }).catch((e) => store().pushTurn({ who: "system", text: String(e), tone: "error", thread }));
  }
}

// ── OS core turn (desktop) ──────────────────────────────────────────────────

/** "ask my booking agent…", "have the coder…" — the user asked for a specific agent by name. */
const NAMES_AGENT = /\b(booking (agent|desk)|book(ing)? agent|librarian|coder|coding agent|designer|design agent|prompter|ops agent|ask (my|the) \w+ agent)\b/i;

async function osRun(plan: ActionPlan, channel: Channel, thread: ThreadId) {
  // Tony-first fast path: in Auto-route / Tony's tab, keyword guesses no longer hand the
  // turn to an AnythingLLM agent (15–40 s, it thinks first). Tony answers with his own
  // tools unless you name an agent — or you're on that agent's tab.
  const onAgentTab = !!plan.explicitRole && plan.role !== "general";
  const role = onAgentTab || NAMES_AGENT.test(plan.utterance) ? plan.role : "general";
  const explicit = onAgentTab;
  let context = await liveContext();
  if (role === "librarian") {
    const hits = await cc.search(plan.utterance, [], 5).catch(() => null);
    if (hits?.results.length) context += `\nLocal vault matches (cite them):\n${hits.results.map((r, i) => `[${i + 1}] (${r.collection}) ${r.snippet.replace(/\s+/g, " ")}`).join("\n")}`;
  }
  // Stream Tony's answer token-by-token into a live bubble.
  const streamId = crypto.randomUUID();
  let live: string | null = null;
  let buffered = "";
  // Voice: start talking at the first complete sentence instead of after the whole answer.
  let spokenUpTo = 0;
  let speakQ: Promise<void> = Promise.resolve();
  const off = await onNativeEvent<{ streamId: string; delta: string }>("tony-token", (e) => {
    if (e.streamId !== streamId) return;
    buffered += e.delta;
    if (!live) live = store().pushTurn({ who: "agent", from: "os", text: buffered, thread, meta: "streaming…" }).id;
    else store().updateTurn(live, { text: buffered });
    if (channel === "voice") {
      const pending = buffered.slice(spokenUpTo);
      // First chunk: the first clause of 20+ chars (a comma is enough) so the first audio
      // is short and renders fast. After that: whole sentences of 40+ chars.
      const m = spokenUpTo === 0 ? /^[\s\S]{20,}?[.!?…,;:](?=\s)/.exec(pending) : /^[\s\S]*?[.!?…](?=\s)/.exec(pending);
      if (m && m[0].trim().length >= (spokenUpTo === 0 ? 20 : 40)) {
        const chunk = m[0].trim();
        spokenUpTo += m[0].length;
        // Render it now, while the previous chunk is still playing — no gap between sentences.
        tts.prefetch?.(chunk);
        if (store().state !== "speaking") {
          store().setState("speaking");
          startBargeIn();
        }
        speakQ = speakQ.then(() => say(chunk));
      }
    }
  });
  const req = { text: plan.utterance, role, explicit, history: history(thread).slice(0, -1), context, streamId };
  let r: OsTurnResult | null;
  try {
    r = await gated(
      { action: "os-turn", summary: `Let ${useSettings.getState().osName} use ${role === "general" ? "its tools" : SUB_AGENTS[role].label}`, detail: { role } },
      (approved) => cmd("os_turn", { req: { ...req, approved } }),
      (x) => x.answer,
    );
  } catch (e) {
    off();
    return fail(e, thread);
  }
  off();
  if (!r) {
    store().setState("idle");
    return;
  }

  // Inter-agent dialogue: delegation lives in that agent's own tab.
  const relayThread: ThreadId = role === "general" ? thread : role;
  for (const s of r.steps) {
    if (explicit && s.kind === "delegate") continue; // you're already talking to it directly
    if (explicit && s.kind === "reply") continue; // shown as the answer below
    const inAgentTab = s.kind === "delegate" || s.kind === "reply" || (s.kind === "error" && s.from === role);
    store().pushTurn({
      who: "relay",
      text: s.text,
      from: s.from,
      to: s.to,
      tone: s.ok ? undefined : "warn",
      meta: s.ms ? `${s.kind} · ${s.ms}ms` : s.kind,
      thread: inAgentTab ? relayThread : thread,
    });
  }
  const linked = r.delegatedTo && !explicit && relayThread !== thread ? relayThread : undefined;
  const meta = [r.providerId, r.tool && `tool ${r.tool}`, r.redacted && "privacy-diffused", `${r.latencyMs}ms`].filter(Boolean).join(" · ");
  const final = { text: r.answer, role, meta, from: explicit ? role : "os", link: linked, commsThread: r.commsThread };
  if (live) {
    // Relay steps were logged after the stream started; move the answer below them.
    store().updateTurn(live, { ...final, at: Date.now() });
    useVoice.setState((s) => ({ turns: [...s.turns.filter((t) => t.id !== live), ...s.turns.filter((t) => t.id === live)] }));
  } else store().pushTurn({ who: "agent", thread, ...final });
  if (channel === "voice") {
    if (spokenUpTo > 0) {
      // Already speaking sentence-by-sentence: queue whatever is left, then wait.
      const rest = r.answer.slice(spokenUpTo).trim();
      if (rest) {
        tts.prefetch?.(rest);
        speakQ = speakQ.then(() => say(rest));
      }
      await speakQ;
    } else {
      store().setState("speaking");
      startBargeIn();
      await say(r.answer);
    }
    return afterVoiceReply();
  }
  if (store().state === "speaking" || store().state === "thinking") store().setState("idle");
}

/** "Ask Claude Overseer" on any message: second opinion on that exchange. */
export async function askOverseer(turn: VoiceTurn) {
  const thread = turn.thread;
  const turns = store().turns.filter((t) => t.thread === thread && (t.who === "user" || t.who === "agent"));
  const idx = turns.findIndex((t) => t.id === turn.id);
  const transcript: ChatMessage[] = turns.slice(Math.max(0, idx - 8), idx + 1).map((t) => ({ role: t.who === "user" ? "user" : "assistant", content: t.text }));
  const engine = useOs.getState().cfg?.overseer.engine ?? "claude-cli";
  store().pushTurn({ who: "relay", from: "os", to: "overseer", text: `Escalated for review (${engine})`, thread });
  store().setState("thinking");
  try {
    const r = await cmd("overseer_ask", {
      req: {
        question:
          turn.who === "agent"
            ? "Review the assistant's last answer. If it's wrong, incomplete or refused something it shouldn't have, give the correct answer or the exact next step."
            : `Answer this directly: ${turn.text}`,
        transcript,
        context: await liveContext(),
      },
    });
    store().pushTurn({ who: "agent", from: "overseer", text: r.answer, meta: `overseer · ${r.engine}${r.redacted ? " · privacy-diffused" : ""} · ${r.latencyMs}ms`, thread });
  } catch (e) {
    store().pushTurn({ who: "system", text: `Overseer: ${e instanceof Error ? e.message : String(e)}`, tone: "error", thread });
  }
  store().setState("idle");
}

// ── Hands-free wake word ────────────────────────────────────────────────────

const wake = { armed: false, timer: undefined as ReturnType<typeof setTimeout> | undefined };

/** Text after a wake word ("hey tony, what's…" → "what's…"), "" for a bare wake word, null if none. */
export function afterWakeWord(text: string): string | null {
  const words = useSettings.getState().wakeWords.map((w) => w.trim().toLowerCase()).filter(Boolean).sort((a, b) => b.length - a.length);
  const t = text.trim().replace(/^[^\w]+/, "");
  const low = t.toLowerCase();
  for (const w of words) {
    if (low.startsWith(w) && !/[a-z]/.test(low.charAt(w.length))) return t.slice(w.length).replace(/^[\s,.!?:;-]+/, "");
  }
  return null;
}

function rearmWake() {
  clearTimeout(wake.timer);
  if (!wake.armed || !stt) return;
  wake.timer = setTimeout(() => {
    const s = store().state;
    if (wake.armed && (s === "idle" || s === "error") && !store().pending) startListening();
    else if (wake.armed) rearmWake();
  }, 600);
}

/** Turn hands-free listening on/off (Settings → Voice, or the HUD). */
export function setWakeMode(on: boolean) {
  wake.armed = on && !!stt;
  useSettings.getState().set({ wakeMode: on });
  if (wake.armed) rearmWake();
  else {
    clearTimeout(wake.timer);
    if (store().state === "listening") stt?.abort();
    store().setState("idle");
  }
}

if (useSettings.getState().wakeMode) setTimeout(() => setWakeMode(true), 1500);

// Cue widgets speak with Tony's voice and can drop a prompt into the conversation.
registerCueIO(
  async (text, voice) => {
    store().setState("speaking");
    await say(text, voice);
    if (store().state === "speaking") store().setState("idle");
  },
  (text) => void handleInput(text, { channel: "text" }),
);
