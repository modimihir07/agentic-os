import { heuristicPlan } from "@/features/orchestrator/plan";
import { requestConfirmation } from "@/features/voice/voice-controller";
import { useToasts } from "@/features/reminders/notify";

/**
 * Show the standard confirmation card for a user-initiated outbound action
 * (send a text, place a call…). Resolves the runner's result, or null if the
 * user cancels / it times out. Nothing runs before the "yes".
 */
export function confirmThen<T>(opts: { action: string; summary: string; readBack?: string; detail?: Record<string, unknown> }, run: () => Promise<T>, describe: (r: T) => string): Promise<T | null> {
  return new Promise<T | null>((resolve, reject) => {
    const plan = heuristicPlan(opts.summary, "ops");
    plan.mutating = true;
    plan.summary = opts.summary;
    plan.intent = opts.summary.charAt(0).toLowerCase() + opts.summary.slice(1);
    plan.readBack = opts.readBack ?? `${opts.summary}. Proceed?`;
    plan.target = { kind: "bridge", action: opts.action, scopes: ["network"] };
    plan.payload = opts.detail ?? {};
    plan.verification = { status: "verified", notes: [], by: "built from your own click" };
    plan.run = async () => {
      try {
        const r = await run();
        resolve(r);
        return { text: describe(r), meta: opts.action };
      } catch (e) {
        reject(e);
        throw e;
      }
    };
    plan.onCancel = () => resolve(null);
    void requestConfirmation(plan, "text");
  });
}

/**
 * Call a Permission-Bridge-gated Rust command.
 *
 * 1. Try it with `approved: false`.
 * 2. `PERMISSION_REQUIRED:<scopes>` (an "ask" tier) → the standard confirmation
 *    card. Approve → re-run with `approved: true` and resolve its result.
 *    Cancel / timeout → resolve `null`; nothing ran.
 * 3. `PERMISSION_DENIED:<scope>` → a toast; resolves `null`.
 */
export function gated<T>(opts: { action: string; summary: string; detail?: Record<string, unknown> }, call: (approved: boolean) => Promise<T>, describe: (r: T) => string): Promise<T | null> {
  return call(false).catch((err: unknown) => {
    const msg = String(err);
    if (msg.startsWith("PERMISSION_DENIED:")) {
      useToasts.getState().push({ title: "Blocked by the Permission Bridge", body: `${opts.summary} needs ${msg.split(":")[1]}, which is set to deny (Settings → Integrations).`, tone: "error" });
      return null;
    }
    if (!msg.startsWith("PERMISSION_REQUIRED:")) throw err;
    const scopes = msg.split(":")[1].split(",");
    return new Promise<T | null>((resolve, reject) => {
      const plan = heuristicPlan(opts.summary, "ops");
      plan.mutating = true;
      plan.summary = opts.summary;
      plan.intent = opts.summary.charAt(0).toLowerCase() + opts.summary.slice(1);
      plan.readBack = `${opts.summary}. This needs ${scopes.join(" and ")} permission. Proceed?`;
      plan.target = { kind: "bridge", action: opts.action, scopes };
      plan.payload = opts.detail ?? {};
      plan.verification = { status: "verified", notes: [], by: "built from your own click" };
      plan.run = async () => {
        try {
          const r = await call(true);
          resolve(r);
          return { text: describe(r), meta: `Permission Bridge · ${opts.action} · ${scopes.join("+")}` };
        } catch (e) {
          reject(e);
          throw e;
        }
      };
      plan.onCancel = () => resolve(null);
      void requestConfirmation(plan, "text");
    });
  });
}
