import { osName } from "@/features/os/os-store";

/**
 * The ONE shared list of agent role ids (Tony first, then the sub-agents in routing
 * tie-break order). `general` is Tony; "tony" is accepted as an alias in config/UI input.
 */
export const ROLE_IDS = ["general", "booking", "prompter", "coder", "designer", "librarian", "ops"] as const;
export type RoleId = (typeof ROLE_IDS)[number];

export const isRoleId = (s: string): s is RoleId => (ROLE_IDS as readonly string[]).includes(s);

/** "tony" → "general"; anything unknown → null. */
export function toRoleId(s: string): RoleId | null {
  const v = s.trim().toLowerCase();
  if (v === "tony") return "general";
  return isRoleId(v) ? v : null;
}

/** Display label: general → the OS name ("Tony"), booking → "Booking Desk", others capitalised. */
export function roleLabel(id: string): string {
  if (id === "general" || id === "tony") return osName();
  if (id === "booking") return "Booking Desk";
  return id.charAt(0).toUpperCase() + id.slice(1);
}

/** Every sub-agent (not Tony), in the order Part 2's drawer pills use: Booking
 * Desk · Coder · Prompter · Designer · Librarian · Ops. */
export const SUB_AGENT_IDS = ["booking", "coder", "prompter", "designer", "librarian", "ops"] as const;

/**
 * Toggle `id` in a grant list that treats `"all"` as a wildcard for every
 * agent (used by both MCP server grants and skill grants, which both accept
 * it). `allIds` is every concrete agent id "all" stands in for.
 *
 * - Toggling `"all"` itself is a plain on/off: on → `["all"]`, off → `[]`.
 * - Toggling a concrete id while `"all"` is active expands to an explicit
 *   list of every id except the one just turned off (same resulting access,
 *   now spelled out) rather than silently doing nothing.
 * - Otherwise it's a normal add/remove from the explicit list.
 */
export function toggleGrant(list: string[], id: string, allIds: readonly string[]): string[] {
  const isAll = list.includes("all");
  if (id === "all") return isAll ? [] : ["all"];
  if (isAll) return allIds.filter((a) => a !== id);
  return list.includes(id) ? list.filter((a) => a !== id) : [...list, id];
}
