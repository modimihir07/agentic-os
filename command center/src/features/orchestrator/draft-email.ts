/**
 * "draft an email to sam@acme.ca about lunch saying I'll be ten minutes late"
 * → a Gmail draft (to, subject, body). Pure: plan.ts turns the result into a
 * mutating plan (confirmation card) or a read-only follow-up question.
 *
 * Only the verb "draft" (or the noun "draft") always binds. "write/compose an
 * email to …" binds only when it names an address — otherwise it stays a
 * normal request, so "write an email to my landlord about the leak" still
 * gets the text written in chat.
 */

export type DraftParse = { kind: "draft"; to: string; subject: string; body: string } | { kind: "ask"; reply: string };

const HEAD = /^(draft|write|compose|prepare|create|make)\s+(?:me\s+)?(?:(?:an?|the|another)\s+)?(?:(?:new|quick|short|brief)\s+)?(draft\s+)?(e-?mail|gmail|mail|reply|draft)(?:\s+draft)?\b[\s,:]*(.*)$/i;
const LEAD = /^(?:(?:please|can you|could you|would you|go ahead and|i need you to|i want you to)\s+)+/i;
const EMAILISH = /\b(e-?mails?|gmail|mail|inbox)\b|@/i;

const ADDR = String.raw`[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+`;
/** Whisper sometimes writes an address the way it was said: "sam at acme dot ca", or
 * half-said: "sam at gmail.com". */
const SPOKEN = String.raw`[a-z0-9][a-z0-9._+-]*\s+at\s+[a-z0-9-]+(?:(?:\s+dot\s+|\.)[a-z0-9-]+)+`;
const ONE = `(?:${ADDR}|${SPOKEN})`;
const RECIPIENTS = new RegExp(`^(?:to|for)\\s+(${ONE}(?:\\s*(?:,|\\band\\b|&)\\s*${ONE})*)`, "i");

const SAYING = String.raw`(?:saying|that says|telling (?:him|her|them)(?:\s+that)?|to say|(?:and\s+)?(?:the\s+)?body(?:\s+is)?)`;
const SUBJECT = new RegExp(String.raw`^(?:with\s+)?(?:the\s+|a\s+)?subject(?:\s+line)?(?:\s+is|\s+of)?\s*:?\s+(.+?)(?:\s*[,;.]?\s+${SAYING}\s*:?\s+(.+))?$`, "is");
const TOPIC = new RegExp(String.raw`^(?:about|regarding|re|concerning)\s*:?\s+(.+?)(?:\s*[,;.]?\s+${SAYING}\s*:?\s+(.+))?$`, "is");
const BODY = new RegExp(String.raw`^(?:${SAYING}|that)\s*:?\s+(.+)$`, "is");

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const tidy = (s: string) => s.trim().replace(/\s+/g, " ");

function toAddresses(list: string): string[] {
  return list
    .split(/\s*(?:,|\band\b|&)\s*(?=[a-z0-9])/i)
    .map((a) => a.trim().toLowerCase().replace(/\s+at\s+/, "@").replace(/\s+dot\s+/g, "."))
    .filter(Boolean);
}

/** A subject from the body when none was said: the first clause, at most 8 words. */
function subjectFrom(body: string): string {
  const first = body.split(/[.!?\n]/)[0] ?? body;
  const words = first.split(/\s+/).filter(Boolean);
  return words.slice(0, 8).join(" ") + (words.length > 8 ? "…" : "");
}

function content(rest: string): { subject: string; body: string } | null {
  const r = rest.replace(/^[\s,:;.-]+/, "").replace(/[\s,]+$/, "");
  if (!r) return null;
  let m: RegExpExecArray | null;
  let subject = "";
  let body = "";
  if ((m = SUBJECT.exec(r))) [subject, body] = [m[1], m[2] ?? ""];
  else if ((m = TOPIC.exec(r))) [subject, body] = [m[1], m[2] ?? m[1]];
  else if ((m = BODY.exec(r))) body = m[1];
  else body = r;
  body = tidy(body);
  subject = tidy(subject).replace(/[.!?,;:]+$/, "") || subjectFrom(body).replace(/[.!?,;:]+$/, "");
  if (!body) return null;
  return { subject: cap(subject).slice(0, 120), body: cap(body) };
}

/** The name in "draft an email to Sam about …" — for the follow-up question only. */
function spokenName(rest: string): string | null {
  const m = /^(?:to|for)\s+([a-z][a-z'-]*(?:\s+[a-z][a-z'-]*){0,2}?)(?=\s+(?:about|regarding|re|saying|that|telling|with|subject)\b|[\s,.]*$)/i.exec(rest);
  if (!m || /\b(my|the|his|her|their|our|last|latest|this|that)\b/i.test(m[1])) return null;
  return m[1].replace(/\b\w/g, (c) => c.toUpperCase());
}

export function parseDraftEmail(text: string): DraftParse | null {
  const t = tidy(text).replace(LEAD, "").replace(/[\s.!?]+$/, "");
  const m = HEAD.exec(t);
  if (!m) return null;
  const [, verb, draftAdj, noun, rest] = m;
  const draftish = verb.toLowerCase() === "draft" || !!draftAdj || noun.toLowerCase() === "draft";
  // "draft a reply to Maria" is a WhatsApp/text reply unless the line is about email.
  const nounIsEmail = /^(e-?mail|gmail|mail)$/i.test(noun);
  if (!nounIsEmail && !EMAILISH.test(t)) return null;

  const to = RECIPIENTS.exec(rest);
  if (!to) {
    if (!draftish) return null;
    const name = spokenName(rest);
    const example = '"draft an email to sam@example.com about lunch"';
    return { kind: "ask", reply: name ? `What's ${name}'s email address? Say it like ${example}.` : `Who should the draft go to? Say the address, like ${example}.` };
  }
  const addresses = toAddresses(to[1]);
  const c = content(rest.slice(to[0].length));
  if (!c) return { kind: "ask", reply: `What should the email to ${addresses.join(", ")} say? Try "draft an email to ${addresses[0]} saying …".` };
  return { kind: "draft", to: addresses.join(", "), ...c };
}
