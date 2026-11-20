import { create } from "zustand";
import { isTauri } from "@/lib/platform";
import { audioContext } from "@/features/voice/engines";

/** On-screen toasts (alarms, sync notices). */
export interface Toast {
  id: string;
  title: string;
  body?: string;
  tone: "alarm" | "info" | "error";
  actions?: { label: string; run: () => void }[];
}

export const useToasts = create<{ toasts: Toast[]; push: (t: Omit<Toast, "id">) => string; dismiss: (id: string) => void }>((set) => ({
  toasts: [],
  push: (t) => {
    const id = crypto.randomUUID();
    set((s) => ({ toasts: [...s.toasts.slice(-4), { ...t, id }] }));
    if (t.tone !== "alarm") setTimeout(() => useToasts.getState().dismiss(id), 6000);
    return id;
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })),
}));

/** OS-level notification: Tauri plugin on desktop, Web Notifications on the PWA. */
export async function systemNotify(title: string, body: string) {
  try {
    if (isTauri()) {
      const n = await import("@tauri-apps/plugin-notification");
      let ok = await n.isPermissionGranted();
      if (!ok) ok = (await n.requestPermission()) === "granted";
      if (ok) n.sendNotification({ title, body });
      return;
    }
    if (!("Notification" in window)) return;
    if (Notification.permission === "default") await Notification.requestPermission();
    if (Notification.permission === "granted") {
      // Service-worker notifications survive a backgrounded PWA better on Android.
      const reg = await navigator.serviceWorker?.getRegistration();
      if (reg) await reg.showNotification(title, { body, icon: "icons/icon-192.png", tag: title });
      else new Notification(title, { body });
    }
  } catch {
    /* best effort — the in-app toast and voice still fire */
  }
}

/** A short, pleasant three-note chime (no audio files needed). */
export async function chime(times = 2) {
  try {
    const ac = await audioContext();
    const notes = [880, 1174.66, 1567.98];
    for (let r = 0; r < times; r++) {
      notes.forEach((f, i) => {
        const o = ac.createOscillator();
        const g = ac.createGain();
        const t0 = ac.currentTime + r * 0.9 + i * 0.16;
        o.type = "sine";
        o.frequency.value = f;
        g.gain.setValueAtTime(0, t0);
        g.gain.linearRampToValueAtTime(0.18, t0 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.5);
        o.connect(g).connect(ac.destination);
        o.start(t0);
        o.stop(t0 + 0.55);
      });
    }
  } catch {
    /* audio blocked until the first user gesture */
  }
}
