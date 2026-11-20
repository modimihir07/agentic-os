import { useEffect } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, ChevronUp, MicOff, Play, X } from "lucide-react";
import { VoiceOrb } from "./VoiceOrb";
import { useNav } from "@/stores/nav";
import { isTauri, onNativeEvent } from "@/lib/platform";
import { STATE_LABEL, useVoice } from "./voice-store";
import { Waveform } from "./Waveform";
import { resumeHold, startListening, stopVoice, toggleListening, voiceCaps } from "./voice-controller";
import { CommandInput, MicButton, STATE_DOT, Transcript } from "./VoiceParts";
import { ListenControls } from "./ListenControls";
import { useOsName } from "@/features/os/os-store";

/**
 * Persistent floating voice HUD (Gemini/Claude-style bubble), rendered once at
 * the app root so a session survives navigation. It steps aside while the
 * Voice Console widget is on screen. That widget is the same HUD, docked.
 *
 * Launchers: Ctrl+Shift+Space (system-wide on desktop via Rust), Ctrl+K
 * (typed), Esc (stop/cancel), and `?voice=1` (PWA home-screen shortcut).
 */
export function VoiceHUD() {
  const osLabel = useOsName();
  const { state, expanded, partial, error, consoleVisible, setExpanded } = useVoice();
  useVoiceLaunchers();

  // Minimised: the floating orb. It hides only while the docked Voice Console
  // widget is on screen AND nothing is happening (the widget already shows it).
  if (!expanded) return consoleVisible && state === "idle" ? null : createPortal(<FloatingOrb />, document.body);

  const body = (
      <div
        role="region"
        aria-label="Voice assistant"
        className={[
          "glass fixed left-1/2 z-50 -translate-x-1/2 rounded-[22px]",
          "bottom-[calc(env(safe-area-inset-bottom)+5rem)] md:bottom-24",
          "w-[min(760px,calc(100vw-2rem))]",
          "origin-bottom animate-[hud-in_260ms_cubic-bezier(0.23,1,0.32,1)]",
        ].join(" ")}
      >
        <style>{`@keyframes hud-in{from{opacity:0;transform:translateY(8px) scale(.97)}to{opacity:1;transform:none}}`}</style>
        <div className="flex items-center gap-3 px-4 pt-3">
          <span className={`size-2 rounded-full ${STATE_DOT[state]}`} />
          <span className="label-caps text-ink">{osLabel} voice</span>
          <span className="label-caps rounded-full border border-amber/30 px-2 py-0.5 text-amber-soft">{STATE_LABEL[state]}</span>
          <div className="ml-auto flex items-center gap-1">
            <IconBtn label={expanded ? "Collapse" : "Expand"} onClick={() => setExpanded(!expanded)}>
              {expanded ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
            </IconBtn>
            <IconBtn
              label="Close voice"
              onClick={() => {
                stopVoice();
                setExpanded(false);
              }}
            >
              <X size={16} />
            </IconBtn>
          </div>
        </div>

        <div className="flex items-center gap-3 px-4 py-2">
          <MicButton />
          <Waveform state={state} height={expanded ? 84 : 52} className="flex-1" />
        </div>

        <ListenControls />

        <HoldBar />

        {(partial || error) && <p className={`px-4 pb-2 text-sm ${error ? "text-alert" : "italic text-ink-2"}`}>{error ?? `“${partial}”`}</p>}

        {expanded ? (
          <>
            <Transcript className="max-h-56 border-t border-white/5 px-4 py-3" />
            <div className="px-4 pb-3 pt-1">
              <CommandInput thread="auto" autoFocus />
            </div>
            <p className="flex items-center gap-2 px-4 pb-3 font-mono text-[10px] text-ink-3">
              {!voiceCaps.stt && <MicOff size={11} />}
              STT: {voiceCaps.sttName} · TTS: {voiceCaps.ttsName}
            </p>
          </>
        ) : (
          <LastReply />
        )}
      </div>
    );

  return createPortal(body, document.body);
}

/**
 * The minimised voice UI: a transparent orb anchored bottom-centre. Tap to
 * talk (tap again to finish), the chevron reopens the full panel. A one-line
 * caption floats above it while something is being heard or said.
 */
function FloatingOrb() {
  const name = useOsName();
  const state = useVoice((s) => s.state);
  const partial = useVoice((s) => s.partial);
  const error = useVoice((s) => s.error);
  const lastAgent = useVoice((s) => s.turns.filter((t) => t.who === "agent").at(-1)?.text);
  const setExpanded = useVoice((s) => s.setExpanded);
  const held = useVoice((s) => s.held);
  // Sit above the wallpaper reel on the Command board; elsewhere hug the bottom edge.
  const hasDock = useNav((s) => s.section === "command");
  const caption =
    error ??
    (partial ? `“${partial}”` : held?.length ? `Holding · “${held.join(" ")}”` : state === "speaking" ? lastAgent : state !== "idle" ? STATE_LABEL[state] : null);

  return (
    <div className={`pointer-events-none fixed inset-x-0 bottom-[calc(env(safe-area-inset-bottom)+4.5rem)] z-50 flex flex-col items-center gap-2 ${hasDock ? "md:bottom-[5.25rem]" : "md:bottom-3"}`}>
      {caption && (
        <p
          aria-live="polite"
          className={`glass-thin max-w-[min(520px,calc(100vw-2rem))] truncate rounded-full px-4 py-1.5 text-sm ${error ? "text-alert" : "text-ink"} animate-[cap-in_200ms_ease-out]`}
        >
          <style>{`@keyframes cap-in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}`}</style>
          {caption}
        </p>
      )}
      <div className="pointer-events-auto flex items-center">
        <button
          onClick={toggleListening}
          aria-label={state === "listening" ? "Finish speaking" : state === "speaking" ? "Stop speaking" : `Talk to ${name} (Ctrl+Shift+Space)`}
          title={`Talk to ${name} · Ctrl+Shift+Space`}
          className="relative grid size-16 place-items-center rounded-full transition-transform duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] hover:scale-105 active:scale-95"
        >
          <VoiceOrb state={state} size={64} />
        </button>
        <button
          onClick={() => setExpanded(true)}
          aria-label="Open voice panel"
          title="Open voice panel · Ctrl+K"
          className="glass-thin -ml-1 grid size-7 place-items-center rounded-full text-ink-2 hover:text-ink"
        >
          <ChevronUp size={14} />
        </button>
        {held && (
          <button onClick={resumeHold} aria-label={held.length ? "Send what's held" : "Resume"} title="Resume (or say “keep going”)" className="glass-thin ml-1 flex h-7 items-center gap-1 rounded-full px-2.5 text-xs text-amber-soft hover:text-ink">
            <Play size={11} /> {held.length ? "Send" : "Resume"}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Hold mode (Phase 2): what you've said since "take it ease", live, and a Resume button —
 * the typed/tap equivalent of "keep going" (sends what's held, or resumes Tony if nothing is).
 */
function HoldBar() {
  const held = useVoice((s) => s.held);
  if (!held) return null;
  return (
    <div className="mx-4 mb-2 flex items-start gap-3 rounded-[14px] border border-amber/25 bg-amber/[0.06] px-3 py-2">
      <div className="min-w-0 flex-1" aria-live="polite">
        <p className="label-caps text-amber-soft">Holding — say “keep going” or “go ahead”</p>
        {held.length ? (
          <p className="mt-1 text-sm text-ink">{held.join(" ")}</p>
        ) : (
          <p className="mt-1 text-sm italic text-ink-3">Paused. Add your thought…</p>
        )}
      </div>
      <button onClick={resumeHold} className="pill-glass !h-8 shrink-0 text-xs" aria-label={held.length ? "Send what's held" : "Resume"}>
        <Play size={12} /> {held.length ? "Send" : "Resume"}
      </button>
    </div>
  );
}

function LastReply() {
  const name = useOsName();
  const last = useVoice((s) => s.turns.filter((t) => t.who === "agent").at(-1));
  if (!last) return null;
  return (
    <p className="line-clamp-1 px-4 pb-3 text-sm text-ink-2">
      <span className="label-caps mr-2 text-teal">{name}</span>
      {last.text}
    </p>
  );
}

/** Hotkeys, the desktop global shortcut, and the PWA `?voice=1` launch. */
function useVoiceLaunchers() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // On desktop the Rust global shortcut owns Ctrl+Shift+Space.
      if (!isTauri() && (e.ctrlKey || e.metaKey) && e.shiftKey && e.code === "Space") {
        e.preventDefault();
        toggleListening();
      } else if (e.key === "Escape" && useVoice.getState().state !== "idle" && !useVoice.getState().pending) stopVoice();
    };
    window.addEventListener("keydown", onKey);
    let unlisten: (() => void) | undefined;
    void onNativeEvent("voice-toggle", toggleListening).then((u) => (unlisten = u));

    // Home-screen shortcut / hardware-button launch: /?voice=1
    const url = new URL(location.href);
    if (url.searchParams.get("voice") === "1") {
      url.searchParams.delete("voice");
      history.replaceState(null, "", url.pathname + url.search + url.hash);
      // Mic needs a user gesture on some browsers; if blocked, the HUD shows a tap-to-talk prompt.
      startListening();
    }
    return () => {
      window.removeEventListener("keydown", onKey);
      unlisten?.();
    };
  }, []);
}

function IconBtn({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button aria-label={label} title={label} onClick={onClick} className="grid size-8 place-items-center rounded-full text-ink-2 hover:bg-white/5 hover:text-ink">
      {children}
    </button>
  );
}
