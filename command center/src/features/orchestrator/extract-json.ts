/**
 * Model-agnostic JSON / tool-call extraction (Part 6 §3) — the TS mirror of
 * Rust's `extract_json` in `dispatch.rs` (also mirrored in Python's
 * `command_center_api.py`). Replaces the naive "first `{` … last `}`" lookup
 * that used to live inline in `plan.ts`, so the planner/verifier survive a
 * model's reasoning scratchpad, a ```json fence, more than one `{…}` span,
 * trailing commas / smart quotes, and either tool-call shape.
 *
 * Split into its own file (no runtime deps) so it's trivially unit-testable,
 * matching the pattern other parts used for pure logic (`vad-rules.ts`,
 * `tts-text.ts`, …).
 */

/** Strip every closed `<think>…</think>`, and drop an unclosed one (and
 * everything after it) — a reasoning model's scratchpad has no usable JSON
 * trailing it in that case. */
function stripThinkLoose(s: string): string {
  let out = s;
  while (true) {
    const a = out.indexOf("<think>");
    const b = out.indexOf("</think>");
    if (a >= 0 && b > a) {
      out = out.slice(0, a) + out.slice(b + "</think>".length);
      continue;
    }
    if (a >= 0 && b < 0) {
      out = out.slice(0, a);
    }
    break;
  }
  return out.trim();
}

function fencedJson(s: string): string | null {
  const m = /```json\s*([\s\S]*?)```/i.exec(s);
  return m ? m[1].trim() : null;
}

/** The index of `}` matching the `{` at `start`, skipping braces inside a
 * quoted string. `null` if it never balances (a truncated reply). */
function matchingBrace(s: string, start: number): number | null {
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (escape) escape = false;
      else if (c === "\\") escape = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return null;
}

/** Every outermost `{…}` span, in order. */
function balancedSpans(s: string): [number, number][] {
  const spans: [number, number][] = [];
  let i = 0;
  while (i < s.length) {
    if (s[i] === "{") {
      const end = matchingBrace(s, i);
      if (end !== null) {
        spans.push([i, end]);
        i = end + 1;
        continue;
      }
    }
    i++;
  }
  return spans;
}

/** Trailing commas before `}`/`]`, and curly quotes a model sometimes emits. */
function lightRepair(s: string): string {
  return s.replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/,\s*([}\]])/g, "$1");
}

/** An OpenAI-style tool call (`{"name":…, "arguments":…}`) is also usable as
 * `{"tool":…, "args":…}` — add the aliases so an existing caller reading
 * either shape keeps working without knowing which one the model used. */
function normalizeToolShape(v: Record<string, unknown>): Record<string, unknown> {
  if (!("tool" in v) && typeof v.name === "string" && "arguments" in v) {
    return { ...v, tool: v.name, args: v.arguments };
  }
  return v;
}

/** Pulls a JSON object out of a model's reply, however messy. `null` when
 * nothing usable is found. */
export function extractJson(text: string): Record<string, unknown> | null {
  const cleaned = stripThinkLoose(text ?? "");
  const candidates: string[] = [];
  const fenced = fencedJson(cleaned);
  if (fenced) candidates.push(fenced);
  const withoutToolTags = cleaned.replace(/<\/?tool_call>/gi, "");
  for (const [a, b] of balancedSpans(withoutToolTags)) candidates.push(withoutToolTags.slice(a, b + 1));
  for (const c of candidates) {
    for (const attempt of [c, lightRepair(c)]) {
      try {
        const v = JSON.parse(attempt);
        if (v && typeof v === "object" && !Array.isArray(v)) return normalizeToolShape(v as Record<string, unknown>);
      } catch {
        /* try the next candidate / repair */
      }
    }
  }
  return null;
}
