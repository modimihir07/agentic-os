import { describe, expect, it } from "vitest";
import { extractJson } from "./extract-json";

describe("extractJson", () => {
  it("parses a plain object", () => {
    expect(extractJson('{"tool": "x", "args": {}}')?.tool).toBe("x");
  });

  it("strips a closed <think> block before scanning", () => {
    const v = extractJson('<think>let me think about {"fake": 1}</think>{"tool": "real", "args": {}}');
    expect(v?.tool).toBe("real");
  });

  it("drops an unclosed <think> block (and anything after it)", () => {
    expect(extractJson('<think>still thinking about {"tool":"x"}')).toBeNull();
  });

  it("prefers a ```json fence", () => {
    const text = 'Sure, here you go:\n```json\n{"tool": "fenced", "args": {"a": 1}}\n```\nHope that helps.';
    expect(extractJson(text)?.tool).toBe("fenced");
  });

  it("tries each brace span when an earlier one is junk", () => {
    const text = `note: {this isn't json} but then {"tool": "second", "args": {}}`;
    expect(extractJson(text)?.tool).toBe("second");
  });

  it("ignores braces that appear inside string values", () => {
    const text = '{"tool": "x", "args": {"note": "use { and } in prose"}}';
    const v = extractJson(text);
    expect(v?.tool).toBe("x");
    expect((v?.args as Record<string, unknown>).note).toBe("use { and } in prose");
  });

  it("repairs trailing commas and smart quotes", () => {
    const text = '{“tool”: “x”, “args”: {“a”: 1,},}';
    const v = extractJson(text);
    expect(v?.tool).toBe("x");
    expect((v?.args as Record<string, unknown>).a).toBe(1);
  });

  it("accepts a <tool_call> tag wrapper", () => {
    expect(extractJson('<tool_call>{"tool": "wrapped", "args": {}}</tool_call>')?.tool).toBe("wrapped");
  });

  it("normalizes the OpenAI name/arguments shape", () => {
    const v = extractJson('{"name": "whatsapp.list_messages", "arguments": {"limit": 5}}');
    expect(v?.tool).toBe("whatsapp.list_messages");
    expect((v?.args as Record<string, unknown>).limit).toBe(5);
    expect(v?.name).toBe("whatsapp.list_messages"); // original keys stay too
  });

  it("returns null when there's no JSON at all", () => {
    expect(extractJson("just a plain sentence, no JSON here")).toBeNull();
  });

  it("returns null on empty input", () => {
    expect(extractJson("")).toBeNull();
  });

  it("returns null for a JSON array (an object is expected)", () => {
    expect(extractJson("[1, 2, 3]")).toBeNull();
  });
});
