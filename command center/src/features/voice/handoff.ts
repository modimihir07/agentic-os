import { roleLabel } from "@/features/dispatcher/roles";

/** Announcer handoff intro, in Tony's voice: "Here's Booking Desk." / "Here's Booking Desk, then Librarian." */
export function introLine(roles: string[]): string {
  return `Here's ${roles.map((r) => roleLabel(r)).join(", then ")}.`;
}
