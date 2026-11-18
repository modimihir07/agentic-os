import { SUB_AGENTS, type AgentRole } from "@/features/dispatcher/agents";
import { roleLabel } from "@/features/dispatcher/roles";
import { DEFAULT_ROUTING_CONFIG, resolve as resolveRoute, type Route } from "@/features/dispatcher/router";
import { execute } from "@/features/orchestrator/execute";
import { parseConfirmation, planIntent, stripWake, type ActionPlan } from "@/features/orchestrator/plan";
import { handleLocalIntent } from "@/features/reminders/intents";
import { gated } from "@/features/bridge/gate";
import { liveContext } from "@/features/os/context";
import { parseOsLine, runOsIntent } from "@/features/os/os-intents";
import type { OsIntent } from "@/features/os/os-intent-parse";
import { useOs } from "@/features/os/os-store";
import { runPipeline, usePipelines } from "@/features/os/pipeline-store";
import { cueFor, fireCue, registerCueIO } from "@/features/cues/cue-runtime";
import { cueRecentlyActive, registerSpeechCancel, setCueDuck, stopAllAudio } from "@/features/cues/player";
import { cc } from "@/lib/cc-api";
import { cmd, isTauri, onNativeEvent, type ChatMessage, type OsTurnResult, type RoutingConfig } from "@/lib/platform";
import { useProviders } from "@/sections/settings/use-providers";
import { useNav } from "@/stores/nav";
import { useSettings } from "@/stores/settings";
import { createEngines, type SpeakOpts } from "./engines";
import { nextStreamChunk } from "./tts-text";
import { useVoice, type Channel, type ThreadId, type VoiceTurn } from "./voice-store";
import { toggleAction, type TurnOrigin } from "./voice-status";
import { wakeCommand } from "./wake-word";

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

/** Says can overlap (osRun's routing notice + streamed chunks), so the cue duck is held while
 * any is in flight. Replaced on a hard speech stop, so a cancelled say can't release a later one's duck. */
let ttsDuck = { depth: 0 };
function releaseTtsDuck() {
  ttsDuck = { depth: 0 };
  setCueDuck("tts", false);
}

/** Defaults to Tony ("general") when the caller names neither a voice nor an agent —
 * every plain Tony line (confirmations, reminders, cancellations…) outside `osRun`'s
 * per-agent answers. A cue's own explicit `voice` (no `agent`) is left exactly as
 * given: cue clips are never routed through the roster (see `registerCueIO` below).
 * Cue audio ducks under the line unless `noDuck` (a cue intro already ducks its own theme). */
async function say(text: string, opts?: SpeakOpts & { noDuck?: boolean }) {
  if (!tts.supported || !text || convo.barged) return;
  const { noDuck, ...speakOpts } = opts ?? {};
  const effective = speakOpts.voice || speakOpts.agent ? speakOpts : { agent: "general" };
  const duck = noDuck ? null : ttsDuck;
  if (duck && duck.depth++ === 0) setCueDuck("tts", true);
  try {
    await tts.speak(text, effective);
  } catch {
    /* speech is best-effort; the text is on screen */
  } finally {
    if (duck && duck === ttsDuck && --duck.depth === 0) setCueDuck("tts", false);
  }
}

/** Does `role`'s roster entry have auto-speak on? Reads whatever `useProviders`
 * last loaded (fetched once at module init, below, and refreshed whenever the
 * Voice settings page is opened) — missing/unloaded roster = no auto-speak,
 * exactly like today. */
function agentAutoSpeak(role: string): boolean {
  return !!useProviders.getState().view?.agentVoices[role === "tony" ? "general" : role]?.autoSpeak;
}

// ── Conversation: barge-in while Tony talks, follow-up listening after ─────
//
// While Tony is speaking a voice reply, the mic listens with a STRICTER trigger
// (echo cancellation removes most of his own voice; the offset covers the rest).
// If you start talking, he stops mid-sentence and your words are transcribed.
// When he finishes, the mic stays open for a few seconds for your follow-up —
// no wake word, no button.
const convo = { barged: false, active: false };

/** Bumped by every hard stop. A turn captures it at its start and stays silent (no speech,
 * no mic reopen) once it changes, so a cancelled turn's late result never resurfaces. */
let micGen = 0;
/** The VAD heard speech during the current listen (the mic button then submits instead of cancelling). */
let heardSpeech = false;
let turnOrigin: TurnOrigin = "text";

/** Follow-up listening and barge-in only while hands-free is on, or for a turn the user started by tapping. */
const conversational = () => useSettings.getState().wakeMode || turnOrigin === "tap";

function speechHandlers() {
  return {
    onPartial: (t: string) => store().setPartial(t),
    onPhase: (p: string) => {
      if (p === "speech") {
        heardSpeech = true;
        setCueDuck("user", true);
      }
      if (p === "speech" && convo.active) {
        // Barge-in: you talked over Tony.
        convo.barged = true;
        convo.active = false;
        tts.cancel();
        store().setState("listening");
      }
      if (p === "transcribing") {
        setCueDuck("user", false);
        store().setState("transcribing");
      }
    },
    onFinal: (t: string) => {
      setCueDuck("user", false);
      convo.active = false;
      store().setPartial("");
      if (t) return void handleInput(t, { channel: "voice" });
      convo.barged = false;
      store().setState(store().pending ? "confirming" : "idle");
      rearmWake();
    },
    onError: (e: string) => {
      setCueDuck("user", false);
      convo.active = false;
      store().setError(e);
    },
  };
}

/** Start listening for a barge-in while a voice reply plays. */
function startBargeIn() {
  const c = useSettings.getState().conversation;
  if (!c.bargeIn || !stt || convo.active || store().pending || !conversational()) return;
  convo.active = true;
  heardSpeech = false;
  stt.start(speechHandlers(), { maxSilenceStartMs: 120_000, sensitivityOffset: -25 });
}

/** Reply finished: hand over to a short follow-up window (or back to rest). `gen` is the turn's `micGen`. */
function afterVoiceReply(gen: number) {
  if (gen !== micGen) return; // hard-stopped while this turn ran
  const c = useSettings.getState().conversation;
  if (convo.barged) return; // already capturing what you said over Tony
  if (convo.active) {
    convo.active = false;
    stt?.abort();
  }
  if (c.followUp && stt && !store().pending && conversational()) {
    store().setState("listening");
    heardSpeech = false;
    stt.start(speechHandlers(), { maxSilenceStartMs: c.followUpSecs * 1000 });
  } else store().setState("idle");
}

/** Re-listens inside a turn (confirmation yes/no, "build that") never pop the HUD open on their own. */
const relistenOpts = () => ({ silent: !store().expanded, origin: turnOrigin });

/**
 * Mic off, now: discards the current listen (nothing is transcribed), drops any turn still
 * transcribing/thinking (see `micGen`) and returns to rest. Hands-free, if still armed, re-arms.
 */
function hardStopMic() {
  micGen++;
  heardSpeech = false;
  convo.active = false;
  convo.barged = false;
  stt?.abort(); // abort() never fires onFinal/onError, so release ducking explicitly here.
  setCueDuck("user", false);
  store().setPartial("");
  store().setState(store().pending ? "confirming" : "idle");
  if (wake.armed) rearmWake();
  else clearTimeout(wake.timer);
}

// ── Listening ───────────────────────────────────────────────────────────────

/** `origin` defaults to "tap": every caller that doesn't pass one is an explicit user action. */
export function startListening(opts: { forConfirmation?: boolean; silent?: boolean; origin?: TurnOrigin } = {}) {
  const v = store();
  const origin = opts.origin ?? "tap";
  // Captured now, not at onFinal: tapping the mic to submit a hands-free listen disarms
  // hands-free first, and that line still has to pass the wake-word check it was heard under.
  const wakeListen = wake.armed && !opts.forConfirmation;
  heardSpeech = false;
  convo.active = false;
  tts.cancel();
  // `silent`: passive hands-free wake-word rearming, not a real interaction yet — never force
  // the floating HUD back open over a user who just closed it (that was the "pops back open on
  // its own" bug). Every other caller here is an explicit tap/hotkey or an actually-detected
  // wake word / pending confirmation, so it keeps expanding as before.
  if (!opts.silent) v.setExpanded(true);
  v.setPartial("");
  if (!stt) {
    v.setError("Speech-to-text unavailable here — type below");
    return;
  }
  v.setState("listening");
  // Cue audio ducks only once the VAD hears you (so Whisper can catch "turn off gabagool mode"
  // over the theme), never just because the mic is open. Released on transcribing/final/error.
  stt.start(
    {
      onPartial: (t) => store().setPartial(t),
      onPhase: (p) => {
        if (p === "speech") {
          heardSpeech = true;
          setCueDuck("user", true);
        }
        if (p === "transcribing") {
          setCueDuck("user", false);
          store().setState("transcribing");
        }
      },
      onFinal: (t) => {
        setCueDuck("user", false);
        store().setPartial("");
        if (t && wakeListen) {
          // Hands-free: only lines that start with a wake word ("Hey Tony…") count.
          const cmdText = useSettings.getState().wakeRequire ? afterWakeWord(t) : t;
          if (cmdText === null) {
            // People shout "stop" / "turn it down" at a cue without the wake word.
            const intent = cueRecentlyActive() ? parseOsLine(t) : null;
            if (intent?.kind === "gabagool-off" || intent?.kind === "cue-volume") return void handleInput(t, { channel: "voice", origin }).finally(rearmWake);
            store().setState("idle");
            return void rearmWake();
          }
          if (!cmdText) {
            store().setState("idle");
            if (wake.armed) startListening({ origin: "wake" });
            return;
          }
          return void handleInput(cmdText, { channel: "voice", origin }).finally(rearmWake);
        }
        if (t) return void handleInput(t, { channel: "voice", origin });
        // Silence: back to the right resting state.
        store().setState(store().pending ? "confirming" : "idle");
        rearmWake();
      },
      onError: (e) => {
        setCueDuck("user", false);
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
  hardStopMic();
  tts.cancel();
  releaseTtsDuck();
  if (store().pending) return reject("stopped");
}

/** Mic button / orb / hotkey. While hands-free is on, a tap on a live listen also turns hands-free off. */
export function toggleListening() {
  const s = store().state;
  switch (toggleAction(s, heardSpeech)) {
    case "submit":
      if (wake.armed) {
        wake.armed = false;
        clearTimeout(wake.timer);
        useSettings.getState().set({ wakeMode: false });
      }
      return finishListening();
    case "hard-stop":
      if (s === "listening" && wake.armed) return setWakeMode(false);
      return hardStopMic();
    case "stop-voice":
      return stopVoice();
    case "start":
      return startListening({ forConfirmation: s === "confirming", origin: "tap" });
  }
}

// ── Routing (Part 1) ─────────────────────────────────────────────────────────
//
// One resolver, used by both the planner (mutating plans → a gateway agent)
// and the OS turn (read-only → an AnythingLLM sub-agent). A Named route
// always wins, even over the tab you're on; a Domain route only overrides
// the tab while you're in Auto-route; otherwise the tab you're on wins
// ("Tab"); with nothing to go on at all, it's Tony ("Default").
function routeFor(utterance: string, thread: ThreadId, routingCfg: RoutingConfig): Route & { role: AgentRole } {
  const det = resolveRoute(utterance, routingCfg);
  const onTab = thread !== "auto";
  if (det.kind === "Named" && det.role) return { ...det, role: det.role as AgentRole };
  if (det.kind === "Domain" && det.role && !onTab) return { ...det, role: det.role as AgentRole };
  if (onTab) return { ...det, role: thread as AgentRole, kind: "Tab", reason: "current tab" };
  return { ...det, role: "general" };
}

// ── Input handling ──────────────────────────────────────────────────────────

/** `origin`: who opened the mic for a voice line; omitted = the current turn's (follow-up / barge-in). */
export async function handleInput(text: string, opts: { channel: Channel; thread?: ThreadId; origin?: TurnOrigin }) {
  const v = store();
  const t = text.trim();
  if (!t) return;
  const gen = micGen;
  const live = () => gen === micGen;
  if (opts.channel === "text") turnOrigin = "text";
  else if (opts.origin) turnOrigin = opts.origin;
  // One parse decides stops, cue volume, Spotify, and whether a cue may fire.
  const intent = parseOsLine(t);
  if (v.pending) {
    if (intent && worksWhileConfirming(intent)) return controlWhileConfirming(t, intent, opts.channel);
    return answerConfirmation(t, opts.channel);
  }

  convo.barged = false;
  // Main bars (VoiceConsole/VoiceHUD/cue IO) pass "auto" or nothing; only use
  // the visible tab when the Agents section is actually what's on screen —
  // never a stale tab left over from an earlier visit (voice-store no longer
  // persists `activeThread` for exactly this reason).
  const thread: ThreadId = opts.thread ?? (useNav.getState().section === "agents" ? v.activeThread : "auto");
  v.pushTurn({ who: "user", text: t, thread });

  // "Stop gabagool mode" (any spelling Whisper produces) — checked BEFORE starting cues,
  // since the phrase itself contains "gabagool mode". Stops the cue clips AND Tony's
  // own speech (the intro line keeps talking otherwise).
  if (intent?.kind === "gabagool-off") {
    stopAllAudio();
    store().pushTurn({ who: "system", text: "Gabagool mode off.", tone: "ok", thread });
    store().setState("idle");
    if (opts.channel === "voice") void say("Alright, shutting it down.");
    return;
  }

  // Voice & Triggers: "enter gabagool mode" etc. run their cue widget (never a restart
  // of a running cue from a line without an ON verb — see `cueFor`).
  const cue = cueFor(t, intent);
  if (cue) {
    store().setState("idle");
    fireCue(cue);
    return;
  }

  // Native OS controls (cue volume, Spotify, workspace switch, model swap, compute mode,
  // kill switch, status, plus a backstop for Gabagool phrasings the cue phrase list doesn't
  // cover): in-process, no gateway hop, no confirmation card — local, reversible controls,
  // so they never reach the planner as a mutating plan.
  const osIntent = intent ? await runOsIntent(intent).catch(() => null) : null;
  if (osIntent) {
    if (osIntent.reply) store().pushTurn({ who: "agent", from: "os", text: osIntent.reply, thread, meta: "os-control" });
    if (!live()) return; // hard-stopped meanwhile: the change happened, but stay silent
    store().setState("idle");
    if (osIntent.reply && opts.channel === "voice") {
      store().setState("speaking");
      startBargeIn();
      await say(osIntent.reply);
      return afterVoiceReply(gen);
    }
    return;
  }
  if (!live()) return;

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
    if (!live()) return;
    if (opts.channel === "voice") {
      v.setState("speaking");
      await say(local.reply);
    }
    store().setState("idle");
    return;
  }
  if (!live()) return;

  const routingCfg = useOs.getState().cfg?.routing ?? DEFAULT_ROUTING_CONFIG;
  const routed = routeFor(stripWake(t), thread, routingCfg);
  let plan;
  try {
    plan = await planIntent(stripWake(t), { role: routed.role, history: history(thread).slice(0, -1) });
  } catch (e) {
    return live() ? fail(e) : undefined;
  }
  if (!live()) return;
  plan.thread = thread;
  plan.routeKind = routed.kind;
  plan.explicitRole = routed.kind === "Tab" || (routed.kind === "Named" && routed.role === thread);

  if (!plan.mutating) return run(plan, opts.channel);
  await requestConfirmation(plan, opts.channel);
}

/**
 * Put a mutating plan in front of the human: card + (for voice) a spoken
 * read-back, then listen for yes/no. Also used by features that build a plan
 * themselves (e.g. "Add to Google Calendar" on a reminder).
 */
export async function requestConfirmation(plan: ActionPlan, channel: Channel) {
  const gen = micGen;
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
    if (gen === micGen && store().pending?.plan.id === plan.id) startListening({ forConfirmation: true, ...relistenOpts() });
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
  const gen = micGen;
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
    if (gen === micGen && store().pending?.plan.id === p.plan.id) startListening({ forConfirmation: true, ...relistenOpts() });
  }
}

/** Audio controls that act at once even while a confirmation card waits (otherwise "stop" reads as an unclear yes/no). */
const worksWhileConfirming = (i: OsIntent) => i.kind === "gabagool-off" || i.kind === "cue-volume" || (i.kind === "media" && i.action === "pause");

/** Run one of those and keep the card: it is still answered by yes/no or a tap. */
async function controlWhileConfirming(text: string, intent: OsIntent, channel: Channel) {
  const gen = micGen;
  const p = store().pending!;
  store().pushTurn({ who: "user", text, thread: p.plan.thread });
  const r = await runOsIntent(intent).catch(() => null);
  if (r?.reply) store().pushTurn({ who: "agent", from: "os", text: r.reply, thread: p.plan.thread, meta: "os-control" });
  if (store().pending?.plan.id !== p.plan.id) return;
  store().setState("confirming");
  if (channel !== "voice" || gen !== micGen) return;
  if (r?.reply) await say(r.reply);
  if (gen === micGen && store().pending?.plan.id === p.plan.id) startListening({ forConfirmation: true, ...relistenOpts() });
}

/** Drop the yes/no listen. abort() silences every STT callback, so the user-speech duck its
 * VAD may have engaged has to be released here (the same as hardStopMic does). */
function abortConfirmListen() {
  stt?.abort();
  heardSpeech = false;
  setCueDuck("user", false);
}

/** The ONLY path by which a mutating plan reaches an executor. */
export async function approve(via: "voice" | "tap" | "typed") {
  const p = store().pending;
  if (!p) return;
  clearTimeout(confirmTimer);
  abortConfirmListen();
  tts.cancel();
  store().setPending(null);
  store().pushTurn({ who: "system", text: `Approved (${via}): ${p.plan.summary}`, tone: "ok", thread: p.plan.thread });
  await run(p.plan, p.channel);
}

export function reject(reason: string) {
  const p = store().pending;
  if (!p) return;
  clearTimeout(confirmTimer);
  abortConfirmListen();
  store().setPending(null);
  p.plan.onCancel?.();
  store().pushTurn({ who: "system", text: `Cancelled (${reason}) — nothing was sent.`, tone: "warn", thread: p.plan.thread });
  store().setState("idle");
  if (p.channel === "voice") void say("Cancelled.");
}

async function run(plan: Parameters<typeof execute>[0], channel: Channel) {
  const gen = micGen;
  store().setState("thinking");
  const thread = plan.thread ?? store().activeThread;
  // Read-only questions go through the OS core (context + sub-agents + tools).
  if (!plan.mutating && plan.target.kind === "agent" && !plan.run && isTauri()) return osRun(plan, channel, thread);
  try {
    const r = await execute(plan, history(thread).slice(0, -1));
    store().pushTurn({ who: "agent", text: r.text, role: plan.role, meta: r.meta, thread, from: "os" });
    if (gen !== micGen) return;
    if (channel === "voice") {
      store().setState("speaking");
      startBargeIn();
      await say(r.text);
      return afterVoiceReply(gen);
    }
    if (store().state === "speaking" || store().state === "thinking") store().setState("idle");
  } catch (e) {
    fail(e);
  }
}

// Raw transport/parsing failures the chain can surface (dispatch.rs / plan.ts /
// the gateway) are developer-shaped, not something to read or speak verbatim
// to the user. Each maps to one calm, spoken-safe line; the raw text is kept
// in the turn's `meta` (shown small, never spoken) for anyone debugging.
const CALM_ERRORS: [RegExp, string][] = [
  [/all providers failed/i, "None of my models answered just now — check Settings → Services, or try again in a moment."],
  [/no reachable providers/i, "None of my models are reachable right now — check Settings → Services."],
  [/malformed (completion|gateway reply)/i, "I got back something I couldn't read from that model — try again, or switch models in Settings."],
  [/planner returned no JSON/i, "I couldn't turn that into a clean plan — try rephrasing it."],
  [/model returned no JSON|verifier gave no verdict/i, "I couldn't organize that cleanly — try again."],
  [/CLI not installed/i, "That assistant isn't installed on this machine."],
  [/timed out/i, "That took too long and timed out — try again."],
  [/unreachable/i, "I couldn't reach that service — check it's running."],
];

function calmMessage(raw: string): string {
  for (const [re, calm] of CALM_ERRORS) if (re.test(raw)) return calm;
  return raw;
}

function fail(e: unknown, thread?: ThreadId) {
  const raw = e instanceof Error ? e.message : String(e);
  const calm = calmMessage(raw);
  store().pushTurn({ who: "system", text: calm, tone: "error", thread, meta: calm === raw ? undefined : raw });
  store().setError(calm);
}

// ── Idea-to-Execution (Stage 1) ─────────────────────────────────────────────

const IDEA = /\b(i'?ve been thinking (about|of)|i'?m thinking (about|of)|i (want|wanna|would like) to (build|make|create)|idea for (an?|my)? ?(app|tool|site|website|product|game|platform|service|plugin|widget)|what if (i|we) (built|made|created)|i have an idea|new idea:|app idea|business idea)\b/i;
const BUILD_YES = /^(yes|yeah|yep|yup|sure|ok(ay)?|do it|go( for it)?|build (it|that)|run (it|the pipeline)|spin (it|one) up|let'?s (do it|go|build))\b/i;
export const looksLikeIdea = (t: string) => IDEA.test(t);

async function captureIdea(text: string, thread: ThreadId, channel: Channel) {
  const gen = micGen;
  store().setState("thinking");
  try {
    const r = await cmd("idea_capture", { text });
    for (const s of r.steps) {
      store().pushTurn({ who: "relay", from: s.from, to: s.to, text: s.text, meta: s.kind, thread: s.to === "librarian" || s.from === "librarian" ? "librarian" : "prompter" });
    }
    const title = r.idea.title;
    usePipelines.getState().setOffered({ ideaId: r.idea.id, title, thread });
    store().pushTurn({ who: "agent", from: "os", text: r.reply, thread, link: "prompter", actions: [{ label: "Yes — run the pipeline", run: `pipeline:${r.idea.id}:${title}` }, { label: "Not now", run: "dismiss-offer" }] });
    if (gen !== micGen) return;
    if (channel === "voice") {
      store().setState("speaking");
      await say(r.reply);
      if (gen !== micGen) return;
      // Listen for "yeah, build that".
      if (store().state === "speaking") store().setState("idle");
      startListening(relistenOpts());
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

// ── OS core turn (desktop) ───────────────────────────────────────────────────

async function osRun(plan: ActionPlan, channel: Channel, thread: ThreadId) {
  const gen = micGen;
  const isLive = () => gen === micGen;
  // Queued sentences check again when their turn comes: a hard stop mid-stream drops the rest.
  const sayLive = (text: string, o: SpeakOpts) => (isLive() ? say(text, o) : undefined);
  const routingCfg = useOs.getState().cfg?.routing ?? DEFAULT_ROUTING_CONFIG;
  const routed = routeFor(plan.utterance, thread, routingCfg);
  const role = routed.role;
  const task = routed.task;
  // "Explicit" = talking directly to the tab you're on — no Tony synthesis,
  // no relay turn, no link pill. A Named/Domain route that pulls you to a
  // *different* agent than the one you're looking at is never explicit, even
  // from that agent's own tab (fixes: naming another agent from Tony's tab,
  // or from a different agent's tab, used to be silently ignored).
  const explicit = thread !== "auto" && role === thread;

  // Tony-feed relay turn for a delegated (not explicit) Named/Domain route.
  // Spoken (Tony's own voice) only for voice turns — a typed handoff notice
  // stays silent even when the target agent has auto-speak on.
  if (!explicit && (routed.kind === "Named" || routed.kind === "Domain")) {
    const short = task.length > 60 ? `${task.slice(0, 57)}…` : task || plan.utterance;
    const notice = `Routing ${short} to ${roleLabel(role)}…`;
    store().pushTurn({ who: "relay", from: "os", to: role, text: notice, thread, meta: "routing" });
    if (channel === "voice" && isLive()) {
      store().setState("speaking");
      startBargeIn();
      // Fire-and-forget: the actual dispatch below doesn't need to wait for this courtesy
      // notice to finish playing (it used to `await` it, stacking its TTS time in front of
      // every delegated turn's real latency). `say()` cancels this mid-sentence on its own
      // if the real answer's first chunk is ready sooner, which reads as the assistant
      // getting straight to the point rather than anything breaking.
      void say(notice, { agent: "general" });
    }
  }

  // Independent I/O — run concurrently instead of one after the other.
  const [context0, librarianHits] = await Promise.all([liveContext(), role === "librarian" ? cc.search(plan.utterance, [], 5).catch(() => null) : Promise.resolve(null)]);
  let context = context0;
  if (librarianHits?.results.length) context += `\nLocal vault matches (cite them):\n${librarianHits.results.map((r, i) => `[${i + 1}] (${r.collection}) ${r.snippet.replace(/\s+/g, " ")}`).join("\n")}`;
  const finalFromFor = (agent: string) => (agent === "general" ? "os" : agent);

  // Stream the answer token-by-token into a live bubble. Two sources feed this
  // same event: Tony's own synthesis (always tagged "general" server-side, or
  // untagged — treated the same) and, for an explicit-tab turn, the sub-agent's
  // own AnythingLLM stream-chat (tagged with that agent's role, Part 6 §1) —
  // never both in the same turn (see agents.rs `run_os_turn`).
  const streamId = crypto.randomUUID();
  let live: string | null = null;
  let buffered = "";
  // Voice: start talking at the first complete sentence instead of after the whole answer.
  let spokenUpTo = 0;
  let speakQ: Promise<void> = Promise.resolve();
  let streamAgent = "general";
  let lastSpokenChunk: string | undefined;
  const off = await onNativeEvent<{ streamId: string; delta: string; agent?: string }>("tony-token", (e) => {
    if (e.streamId !== streamId) return;
    streamAgent = e.agent ?? "general";
    buffered += e.delta;
    if (!live) live = store().pushTurn({ who: "agent", from: finalFromFor(streamAgent), text: buffered, thread, meta: "streaming…" }).id;
    else store().updateTurn(live, { text: buffered });
    if (channel === "voice" && isLive()) {
      const next = nextStreamChunk(buffered, spokenUpTo);
      if (next) {
        const { chunk } = next;
        spokenUpTo = next.end;
        // Render it now, while the previous chunk is still playing — no gap between sentences.
        const previousText = lastSpokenChunk;
        lastSpokenChunk = chunk;
        tts.prefetch?.(chunk, { agent: streamAgent, previousText });
        if (store().state !== "speaking") {
          store().setState("speaking");
          startBargeIn();
        }
        speakQ = speakQ.then(() => sayLive(chunk, { agent: streamAgent, previousText }));
      }
    }
  });
  const req = { text: task, role, explicit, routeKind: routed.kind, routeReason: routed.reason, history: history(thread).slice(0, -1), context, streamId };
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

  // The Rust safety net (phone/inbox turns against the full config) may have
  // refined the role; fall back to what we already computed when it didn't.
  const finalRole = (r.routedRole as AgentRole) || role;
  const finalExplicit = explicit && finalRole === role;

  // Inter-agent dialogue: delegation lives in that agent's own tab.
  const relayThread: ThreadId = finalExplicit ? thread : finalRole === "general" ? thread : finalRole;
  for (const s of r.steps) {
    if (finalExplicit && s.kind === "delegate") continue; // you're already talking to it directly
    if (finalExplicit && s.kind === "reply") continue; // shown as the answer below
    const inAgentTab = s.kind === "delegate" || s.kind === "reply" || (s.kind === "error" && s.from === finalRole);
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
  const linked = r.delegatedTo && !finalExplicit && relayThread !== thread ? relayThread : undefined;
  const meta = [r.providerId, r.tool && `tool ${r.tool}`, r.redacted && "privacy-diffused", `${r.latencyMs}ms`].filter(Boolean).join(" · ");
  const final = { text: r.answer, role: finalRole, meta, from: finalExplicit ? finalRole : "os", link: linked, commsThread: r.commsThread };
  // Who the answer is spoken as: the sub-agent itself only for an explicit-tab
  // direct answer (`final.from` is the agent, not "os"); every Tony-synthesized
  // reply — delegated or his own — speaks as "general", matching `final.from`.
  const voiceAgent = final.from === "os" ? "general" : final.from;
  if (live) {
    // Relay steps were logged after the stream started; move the answer below them.
    store().updateTurn(live, { ...final, at: Date.now() });
    useVoice.setState((s) => ({ turns: [...s.turns.filter((t) => t.id !== live), ...s.turns.filter((t) => t.id === live)] }));
  } else store().pushTurn({ who: "agent", thread, ...final });

  // Auto-switch: when this was delegated (not explicit) and the Agents
  // section is already what's on screen, land the user on the exchange
  // instead of leaving it behind a link pill. Never force-navigate into
  // Agents just to do this — a voice-only HUD just speaks, as it already does.
  if (!finalExplicit && relayThread !== thread && routingCfg.autoSwitch && useNav.getState().section === "agents") {
    store().setActiveThread(relayThread);
  }
  if (!isLive()) return;
  if (channel === "voice") {
    if (spokenUpTo > 0) {
      // Already speaking sentence-by-sentence, in whichever voice streamed
      // (`streamAgent` — Tony's or, for an explicit-tab turn, the sub-agent's
      // own): queue whatever is left, then wait.
      const rest = r.answer.slice(spokenUpTo).trim();
      if (rest) {
        tts.prefetch?.(rest, { agent: streamAgent, previousText: lastSpokenChunk });
        speakQ = speakQ.then(() => sayLive(rest, { agent: streamAgent, previousText: lastSpokenChunk }));
      }
      await speakQ;
    } else {
      store().setState("speaking");
      startBargeIn();
      await say(r.answer, { agent: voiceAgent });
    }
    return afterVoiceReply(gen);
  }
  // Typed turn: silent unless this agent's roster entry has auto-speak on
  // (Part 3) — a voice turn always speaks (above); a typed one only opts in.
  if (isTauri() && agentAutoSpeak(voiceAgent)) {
    store().setState("speaking");
    await say(r.answer, { agent: voiceAgent });
    if (store().state === "speaking") store().setState("idle");
    return;
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

/** Text after a wake word ("Hey, Tony, what's…" → "what's…"), "" for a bare wake word, null if none. */
export function afterWakeWord(text: string): string | null {
  return wakeCommand(text, useSettings.getState().wakeWords);
}

function rearmWake() {
  clearTimeout(wake.timer);
  if (!wake.armed || !stt) return;
  wake.timer = setTimeout(() => {
    const s = store().state;
    if (wake.armed && (s === "idle" || s === "error") && !store().pending) startListening({ silent: true, origin: "wake" });
    else if (wake.armed) rearmWake();
  }, 600);
}

/** Turn hands-free listening on/off (Settings → Voice, or the HUD). */
export function setWakeMode(on: boolean) {
  wake.armed = on && !!stt;
  useSettings.getState().set({ wakeMode: on });
  // Off = hard stop regardless of state: a barge-in listen opens the mic without ever setting
  // state to "listening", and a turn still in flight must not speak or reopen the mic after.
  if (wake.armed) rearmWake();
  else hardStopMic();
}

if (useSettings.getState().wakeMode) setTimeout(() => setWakeMode(true), 1500);

// A stop said during a cue's intro also cancels Tony's TTS (no import cycle: player.ts
// only holds the cancel function, it doesn't import the voice controller).
registerSpeechCancel(() => {
  tts.cancel();
  releaseTtsDuck();
});

// Cue widgets speak with Tony's voice and can drop a prompt into the conversation.
// `voice` here is the cue's OWN explicit voice choice (tied to whichever engine it was
// picked from) — never routed through the agent roster, so `agentAutoSpeak`/the roster's
// "general" fallback never changes which engine a cue clip plays on.
registerCueIO(
  async (text, voice) => {
    store().setState("speaking");
    await say(text, { voice, noDuck: true });
    if (store().state === "speaking") store().setState("idle");
  },
  (text) => void handleInput(text, { channel: "text" }),
);

// The voice roster lives in providers.json, loaded only when Settings → Voice is
// opened; fetch it once up front too, so `agentAutoSpeak`/per-agent voices work for a
// session that never visits Settings. Settings' own `load()` keeps it fresh afterwards.
if (isTauri()) void useProviders.getState().load();

// Rust fell back from an agent's configured engine to a local one (offline, out of
// quota…) — surfaced here instead of only in the Rust console (`eprintln!`).
void onNativeEvent<{ from: string; to: string; reason: string }>("tts-fallback", (e) => {
  store().pushTurn({ who: "system", text: `Voice fell back to ${e.to} — ${e.from} failed (${e.reason})`, tone: "warn" });
});
