import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Delete, Loader2, MessageSquare, Phone, PhoneCall, PhoneIncoming, PhoneMissed, PhoneOutgoing, RefreshCw, Search, Send, ShieldCheck, Zap } from "lucide-react";
import { Card, Empty, Input, SubTabs } from "@/components/ui";
import { gateway } from "@/lib/gateway";
import { cmd, isTauri } from "@/lib/platform";
import { useSettings } from "@/stores/settings";
import { confirmThen } from "@/features/bridge/gate";
import { useFocus } from "@/features/os/focus-store";
import { useToasts } from "@/features/reminders/notify";

interface Thread {
  thread: string;
  contact: string;
  address: string;
  body: string;
  ts: number;
  direction: "in" | "out";
  channel: string;
  unread: number;
  trusted: boolean;
}
interface Message {
  id: string;
  thread: string;
  contact: string;
  address: string;
  direction: "in" | "out";
  body: string;
  ts: number;
  channel: string;
}
interface Call {
  id: string;
  contact: string;
  address: string;
  direction: "in" | "out" | "missed";
  ts: number;
  duration: number;
}

const when = (ts: number) => {
  const d = new Date(ts * 1000);
  return d.toDateString() === new Date().toDateString() ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : d.toLocaleDateString([], { month: "short", day: "numeric" });
};

/** Live push from the gateway (new texts / calls) → refresh. */
function useCommsLive(onEvent: () => void) {
  const { gatewayUrl, gatewayToken } = useSettings();
  const cb = useRef(onEvent);
  cb.current = onEvent;
  useEffect(() => {
    let ws: WebSocket | null = null;
    let closed = false;
    const open = () => {
      try {
        const u = new URL(gatewayUrl);
        u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
        u.pathname = "/api/comms/ws";
        if (gatewayToken.trim()) u.searchParams.set("token", gatewayToken.trim());
        ws = new WebSocket(u.toString());
        ws.onmessage = () => cb.current();
        ws.onclose = () => !closed && setTimeout(open, 5000);
      } catch {
        /* polling still runs */
      }
    };
    open();
    const iv = setInterval(() => cb.current(), 15_000);
    return () => {
      closed = true;
      ws?.close();
      clearInterval(iv);
    };
  }, [gatewayUrl, gatewayToken]);
}

export function CommsSection() {
  return (
    <div className="mx-auto h-full w-full max-w-6xl overflow-y-auto px-4 pb-32 md:px-6 md:pb-8">
      <CommsPanel />
    </div>
  );
}

type Tab = "messages" | "dialer" | "whatsapp" | "setup";

export function CommsPanel({ compact = false }: { compact?: boolean }) {
  const [tab, setTab] = useState<Tab>("messages");
  const tabs: { id: Tab; label: string }[] = [
    { id: "messages", label: "Messages" },
    { id: "dialer", label: "Calls" },
    ...(isTauri() ? [{ id: "whatsapp" as Tab, label: "WhatsApp" }] : []),
    ...(compact ? [] : [{ id: "setup" as Tab, label: "Phone bridge" }]),
  ];
  return (
    <div className="space-y-3">
      <SubTabs tabs={tabs} value={tab} onChange={setTab} />
      {tab === "messages" && <Inbox compact={compact} />}
      {tab === "dialer" && <Dialer />}
      {tab === "whatsapp" && <WhatsAppPanel />}
      {tab === "setup" && <BridgeSetup />}
    </div>
  );
}

// ── Inbox ───────────────────────────────────────────────────────────────────

function Inbox({ compact }: { compact: boolean }) {
  const [threads, setThreads] = useState<Thread[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const focus = useFocus((s) => s.commsThread);
  const [sel, setSel] = useState<string | null>(focus);
  useEffect(() => {
    if (focus) setSel(focus);
  }, [focus]);
  const load = useCallback(() => void gateway<{ threads: Thread[] }>("/api/comms/threads").then((r) => (setThreads(r.threads), setErr(null))).catch((e) => setErr(String(e))), []);
  useEffect(load, [load]);
  useCommsLive(load);
  const list = useMemo(() => (threads ?? []).filter((t) => !q || `${t.contact} ${t.address} ${t.body}`.toLowerCase().includes(q.toLowerCase())), [threads, q]);
  const current = threads?.find((t) => t.thread === sel) ?? null;

  const showList = !compact || !sel;
  const showChat = !compact || !!sel;
  return (
    <div className={`grid gap-3 ${compact ? "" : "md:grid-cols-[320px_1fr]"}`}>
      {showList && (
        <Card title="Conversations" action={<button onClick={load} aria-label="Refresh" className="text-ink-3 hover:text-ink"><RefreshCw size={13} /></button>}>
          <div className="relative mb-2">
            <Search size={13} className="absolute left-3 top-3 text-ink-3" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search people & texts" className="!pl-8" />
          </div>
          {err && <p className="text-xs text-alert">{err}</p>}
          {threads && !list.length && <Empty>No messages synced yet — set up the phone bridge.</Empty>}
          <ul className="max-h-[60vh] space-y-1 overflow-y-auto">
            {list.map((t) => (
              <li key={t.thread}>
                <button
                  onClick={() => {
                    setSel(t.thread);
                    if (t.unread) void gateway(`/api/comms/threads/${encodeURIComponent(t.thread)}/read`, { method: "POST" }).then(load);
                  }}
                  className={`w-full rounded-[12px] px-3 py-2 text-left transition-colors ${sel === t.thread ? "bg-amber/10" : "hover:bg-white/5"}`}
                >
                  <div className="flex items-center gap-2">
                    <span className={`truncate text-sm ${t.unread ? "font-semibold text-ink" : "text-ink"}`}>{t.contact}</span>
                    {t.channel !== "sms" && <span className="label-caps text-teal">{t.channel}</span>}
                    {t.trusted && <ShieldCheck size={11} className="text-teal" />}
                    <span className="ml-auto shrink-0 font-mono text-[10px] text-ink-3">{when(t.ts)}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="truncate text-xs text-ink-3">{t.direction === "out" ? "You: " : ""}{t.body}</span>
                    {t.unread > 0 && <span className="ml-auto grid size-4 shrink-0 place-items-center rounded-full bg-amber font-mono text-[9px] text-canvas">{t.unread}</span>}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {showChat && (current ? <Chat thread={current} onBack={compact ? () => setSel(null) : undefined} onChange={load} /> : !compact && <Card><Empty>Pick a conversation.</Empty></Card>)}
    </div>
  );
}

function Chat({ thread, onBack, onChange }: { thread: Thread; onBack?: () => void; onChange: () => void }) {
  const [msgs, setMsgs] = useState<Message[] | null>(null);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const load = useCallback(() => void gateway<{ messages: Message[] }>(`/api/comms/threads/${encodeURIComponent(thread.thread)}/messages`).then((r) => setMsgs(r.messages)), [thread.thread]);
  useEffect(load, [load]);
  useCommsLive(load);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [msgs?.length]);
  const whatsapp = thread.channel === "whatsapp" || thread.thread.includes("@");

  const send = async () => {
    const body = text.trim();
    if (!body) return;
    setSending(true);
    try {
      const doSend = async (confirmed: boolean) => {
        if (whatsapp) {
          if (!isTauri()) throw new Error("WhatsApp replies are sent from the desktop (WhatsApp MCP).");
          return cmd("comms_whatsapp_send", { recipient: thread.address, message: body, approved: confirmed });
        }
        return gateway("/api/comms/send", { method: "POST", body: JSON.stringify({ address: thread.address, contact: thread.contact, body, channel: "sms", confirmed }) });
      };
      const r = thread.trusted
        ? await doSend(false) // Instant Send: trusted contact, no card
        : await confirmThen(
            { action: "comms-send", summary: `Text ${thread.contact}: “${body.slice(0, 80)}”`, readBack: `Send this ${whatsapp ? "WhatsApp" : "text"} to ${thread.contact}: ${body.slice(0, 140)}. Send it?`, detail: { to: thread.address, channel: whatsapp ? "whatsapp" : "sms" } },
            () => doSend(true),
            () => (whatsapp ? "Sent on WhatsApp." : "Queued — your phone sends it."),
          );
      if (r !== null) {
        setText("");
        load();
        onChange();
      }
    } catch (e) {
      useToasts.getState().push({ title: "Not sent", body: String(e), tone: "error" });
    } finally {
      setSending(false);
    }
  };

  const toggleTrust = () => void gateway("/api/comms/contacts", { method: "POST", body: JSON.stringify({ address: thread.address, name: thread.contact, trusted: !thread.trusted }) }).then(onChange);

  return (
    <section className="glass flex min-h-[420px] flex-col rounded-[20px]">
      <header className="flex items-center gap-2 border-b border-white/5 px-4 py-3">
        {onBack && (
          <button onClick={onBack} aria-label="Back" className="text-ink-2">
            <ArrowLeft size={16} />
          </button>
        )}
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-ink">{thread.contact}</p>
          <p className="font-mono text-[11px] text-ink-3">{thread.address} · {whatsapp ? "WhatsApp" : "SMS"}</p>
        </div>
        <a href={`tel:${thread.address.replace(/[^\d+]/g, "")}`} className="pill-glass ml-auto !h-8 !w-8 !p-0" aria-label={`Call ${thread.contact}`} title="Call">
          <Phone size={13} />
        </a>
        <button onClick={toggleTrust} className={`pill-glass !h-8 text-[11px] ${thread.trusted ? "!border-teal/60 text-teal" : ""}`} title="Instant Send: replies to this contact skip the confirmation card">
          <Zap size={12} /> {thread.trusted ? "Instant Send on" : "Instant Send"}
        </button>
      </header>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-4" style={{ maxHeight: "60vh" }}>
        {!msgs && <Loader2 size={14} className="animate-spin text-ink-3" />}
        {msgs?.map((m) => (
          <div key={m.id} className={`flex ${m.direction === "out" ? "justify-end" : ""}`}>
            <div className={`max-w-[78%] rounded-[16px] px-3 py-2 text-sm ${m.direction === "out" ? "bg-amber/20 text-ink" : "bg-white/[0.06] text-ink"}`}>
              <p className="whitespace-pre-wrap break-words">{m.body}</p>
              <p className="mt-0.5 text-right font-mono text-[10px] text-ink-3">{new Date(m.ts * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</p>
            </div>
          </div>
        ))}
        <div ref={end} />
      </div>
      <form
        className="flex gap-2 border-t border-white/5 p-3"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder={thread.trusted ? "Message (Instant Send)…" : "Message — confirmed before sending…"} className="field !h-10 !rounded-full" aria-label="Reply" />
        <button className="pill-primary !h-10 !w-10 shrink-0 !p-0" disabled={!text.trim() || sending} aria-label="Send">
          {sending ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
        </button>
      </form>
    </section>
  );
}

// ── Dialer + recent calls ───────────────────────────────────────────────────

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"];

function Dialer() {
  const [num, setNum] = useState("");
  const [calls, setCalls] = useState<Call[] | null>(null);
  const [contacts, setContacts] = useState<{ address: string; name: string }[]>([]);
  const load = useCallback(() => void gateway<{ calls: Call[] }>("/api/comms/calls").then((r) => setCalls(r.calls)).catch(() => setCalls([])), []);
  useEffect(load, [load]);
  useCommsLive(load);
  useEffect(() => {
    if (!num || /^[\d+*#\s()-]+$/.test(num)) return setContacts([]);
    const t = setTimeout(() => void gateway<{ contacts: { address: string; name: string }[] }>(`/api/comms/contacts?q=${encodeURIComponent(num)}`).then((r) => setContacts(r.contacts)), 250);
    return () => clearTimeout(t);
  }, [num]);
  const digits = num.replace(/[^\d+*#]/g, "");

  const callViaBridge = (address: string, label: string) =>
    void confirmThen(
      { action: "comms-call", summary: `Call ${label}`, readBack: `Place a call to ${label} from your phone?`, detail: { to: address } },
      () => gateway("/api/comms/call", { method: "POST", body: JSON.stringify({ address, contact: label, confirmed: true }) }),
      () => "Your phone is dialing.",
    ).catch((e) => useToasts.getState().push({ title: "Call failed", body: String(e), tone: "error" }));

  const icon = (d: Call["direction"]) => (d === "missed" ? <PhoneMissed size={13} className="text-alert" /> : d === "out" ? <PhoneOutgoing size={13} className="text-teal" /> : <PhoneIncoming size={13} className="text-volt" />);
  return (
    <div className="grid gap-3 md:grid-cols-[300px_1fr]">
      <Card title="Dialer">
        <Input value={num} onChange={(e) => setNum(e.target.value)} placeholder="Number or name" className="text-center font-mono !text-lg" aria-label="Number or contact" />
        {contacts.length > 0 && (
          <ul className="mt-1 space-y-0.5">
            {contacts.slice(0, 5).map((c) => (
              <li key={c.address}>
                <button onClick={() => setNum(c.address)} className="w-full rounded-[8px] px-2 py-1 text-left text-xs text-ink-2 hover:bg-white/5">
                  {c.name} · <span className="font-mono">{c.address}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-3 grid grid-cols-3 gap-2">
          {KEYS.map((k) => (
            <button key={k} onClick={() => setNum((n) => n + k)} className="well h-12 rounded-[14px] font-mono text-lg text-ink active:scale-95">
              {k}
            </button>
          ))}
        </div>
        <div className="mt-3 flex gap-2">
          <a
            href={digits ? `tel:${digits}` : undefined}
            className={`pill-primary !h-11 flex-1 justify-center ${digits ? "" : "pointer-events-none opacity-40"}`}
            title={isTauri() ? "Opens your system dialer (Windows Phone Link)" : "Opens your phone's dialer"}
          >
            <PhoneCall size={16} /> Call
          </a>
          {isTauri() && (
            <button disabled={!digits} onClick={() => callViaBridge(digits, digits)} className="pill-glass !h-11 text-xs" title="Ask the phone bridge to dial">
              via phone
            </button>
          )}
          <button onClick={() => setNum((n) => n.slice(0, -1))} className="pill-glass !h-11 !w-11 !p-0" aria-label="Backspace">
            <Delete size={15} />
          </button>
        </div>
      </Card>
      <Card title="Recent calls" action={<button onClick={load} aria-label="Refresh" className="text-ink-3 hover:text-ink"><RefreshCw size={13} /></button>}>
        {calls && !calls.length && <Empty>No call log synced yet.</Empty>}
        <ul className="max-h-[60vh] divide-y divide-white/5 overflow-y-auto">
          {calls?.map((c) => (
            <li key={c.id} className="flex items-center gap-3 py-2">
              {icon(c.direction)}
              <div className="min-w-0">
                <p className="truncate text-sm text-ink">{c.contact}</p>
                <p className="font-mono text-[11px] text-ink-3">
                  {when(c.ts)} · {c.direction}
                  {c.duration ? ` · ${Math.round(c.duration / 60)}m` : ""}
                </p>
              </div>
              <a href={`tel:${c.address.replace(/[^\d+]/g, "")}`} className="pill-glass ml-auto !h-8 !w-8 !p-0" aria-label={`Call ${c.contact} back`}>
                <Phone size={13} />
              </a>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

// ── WhatsApp (local MCP bridge) ─────────────────────────────────────────────

function WhatsAppPanel() {
  const [out, setOut] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [to, setTo] = useState("");
  const [msg, setMsg] = useState("");
  const run = async (f: () => Promise<string>) => {
    setBusy(true);
    try {
      setOut(await f());
    } catch (e) {
      setOut(`⚠ ${e}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="WhatsApp (local MCP bridge)" hint="Uses the WhatsApp MCP in Settings → Integrations → MCP registry (start its Go bridge first). Reading is direct; sending always shows the confirmation card unless the contact is trusted.">
      <div className="flex flex-wrap gap-2">
        <button onClick={() => void run(() => cmd("comms_whatsapp", { action: "chats", args: { limit: 20 } }))} className="pill-glass !h-9 text-xs" disabled={busy}>
          <MessageSquare size={13} /> Recent chats
        </button>
        <button onClick={() => void run(() => cmd("comms_whatsapp", { action: "messages", args: { limit: 30 } }))} className="pill-glass !h-9 text-xs" disabled={busy}>
          Latest messages
        </button>
        {busy && <Loader2 size={14} className="mt-2 animate-spin text-ink-3" />}
      </div>
      {out && <pre className="well mt-2 max-h-80 overflow-auto whitespace-pre-wrap rounded-[10px] p-2 text-[11px] text-ink-2">{out.slice(0, 12000)}</pre>}
      <form
        className="mt-3 grid gap-2 sm:grid-cols-[1fr_2fr_auto]"
        onSubmit={(e) => {
          e.preventDefault();
          if (!to.trim() || !msg.trim()) return;
          void confirmThen(
            { action: "whatsapp-send", summary: `WhatsApp ${to}: “${msg.slice(0, 60)}”`, detail: { to } },
            () => cmd("comms_whatsapp_send", { recipient: to.trim(), message: msg.trim(), approved: true }),
            () => "Sent on WhatsApp.",
          ).then((r) => r !== null && setMsg(""));
        }}
      >
        <Input value={to} onChange={(e) => setTo(e.target.value)} placeholder="Phone (with country code) or JID" className="font-mono !text-[12px]" />
        <Input value={msg} onChange={(e) => setMsg(e.target.value)} placeholder="Message" />
        <button className="pill-primary !h-10 text-xs">
          <Send size={13} /> Send
        </button>
      </form>
    </Card>
  );
}

// ── Phone bridge setup ──────────────────────────────────────────────────────

function BridgeSetup() {
  const gw = useSettings((s) => s.gatewayUrl);
  const ex = `{"messages":[{"address":"%SMSRF","contact":"%SMSRN","body":"%SMSRB","ts":"%TIMEMS","direction":"in"}]}`;
  return (
    <Card title="Galaxy S22 → MORTADELLA bridge" hint="There's no official Android API for another device to read your texts, so the phone pushes them. Any automation app works (Tasker, MacroDroid, Automate, “SMS Gateway”). Use your NetBird address, and the gateway token as a Bearer header.">
      <ol className="list-decimal space-y-2 pl-5 text-sm text-ink-2">
        <li>
          <b className="text-ink">Incoming / sent texts</b> → HTTP POST <code className="font-mono text-amber-light">{gw}/api/comms/sms</code> with JSON body
          <pre className="well mt-1 overflow-x-auto rounded-[8px] p-2 font-mono text-[11px]">{ex}</pre>
          (Tasker variables shown; <code>direction</code> is <code>in</code> or <code>out</code>.)
        </li>
        <li>
          <b className="text-ink">Call log</b> → POST <code className="font-mono text-amber-light">{gw}/api/comms/call-log</code> with <code className="font-mono">{`{"address","contact","direction":"in|out|missed","ts","duration"}`}</code>.
        </li>
        <li>
          <b className="text-ink">Replies & calls from the OS</b> → poll GET <code className="font-mono text-amber-light">{gw}/api/comms/outbox</code> every ~10 s (or open the WebSocket <code className="font-mono">/api/comms/ws</code>), send the SMS / dial, then POST <code className="font-mono">/api/comms/outbox/&lt;id&gt;/ack</code> with <code className="font-mono">{`{"status":"sent"}`}</code>.
        </li>
        <li>
          Header on every request: <code className="font-mono">Authorization: Bearer &lt;gateway token&gt;</code> (desktop → Settings → Integrations → New phone token).
        </li>
      </ol>
      <p className="mt-3 text-xs text-ink-3">Everything lands in a local comms-history store on this desktop and is indexed for the Librarian, so “Hey Tony, what did Sam say about the shoot?” quotes it back with timestamps.</p>
    </Card>
  );
}
