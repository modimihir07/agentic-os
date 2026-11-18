import { describe, expect, it } from "vitest";
import type { OsKeySources, OsKeyStatus, OsSecret } from "@/lib/platform";
import { MAX_SECRET_CHARS, keyBadge, secretInputError, withKeychain } from "./key-sources";

const st = (source: OsKeyStatus["source"], envVar: string | null, keychain = false, pairIncomplete = false): OsKeyStatus => ({ source, envVar, keychain, pairIncomplete });
const meta = { envFile: "D:\\repo\\.env", envFileFound: true };

describe("keyBadge", () => {
  it("shows .env as green with the var name", () => {
    const b = keyBadge(st("env-file", "BRAVE_API_KEY"), meta);
    expect(b).toMatchObject({ label: "LOADED FROM .ENV", tone: "ok", detail: "BRAVE_API_KEY in .env", placeholder: "Optional keychain fallback…", canDelete: false });
  });

  it("shows the process environment and a saved keychain fallback", () => {
    const b = keyBadge(st("env", "ANTHROPIC_API_KEY", true), meta);
    expect(b.label).toBe("LOADED FROM ENVIRONMENT");
    expect(b.detail).toBe("ANTHROPIC_API_KEY (process env) · keychain fallback saved");
    expect(b.canDelete).toBe(true);
  });

  it("shows keychain as green with the override hint", () => {
    expect(keyBadge(st("keychain", "GEMINI_API_KEY", true), meta)).toMatchObject({ label: "SAVED IN KEYCHAIN", tone: "ok", detail: "set GEMINI_API_KEY in the repo-root .env to override", placeholder: "Replace…", canDelete: true });
    // Keychain-only secrets have no override hint.
    expect(keyBadge(st("keychain", null, true), meta).detail).toBeNull();
  });

  it("explains a missing key, a half Gmail pair and a missing .env", () => {
    expect(keyBadge(st("missing", "ANTHROPIC_API_KEY"), meta)).toMatchObject({ label: "NOT SET", tone: "muted", detail: "paste it here, or set ANTHROPIC_API_KEY in the repo-root .env", canDelete: false });
    expect(keyBadge(st("missing", "GMAIL_SCRIPT_KEY", true, true), meta)).toMatchObject({ canDelete: true });
    expect(keyBadge(st("missing", "GMAIL_SCRIPT_KEY", false, true), meta).detail).toMatch(/Gmail needs both ID and key/);
    expect(keyBadge(st("missing", "BRAVE_API_KEY"), { envFile: "C:\\x\\.env", envFileFound: false }).detail).toMatch(/\.env not found at C:\\x\\\.env/);
    expect(keyBadge(st("missing", null), meta).detail).toBeNull();
  });

  it("uses the caller placeholder only while nothing is set", () => {
    expect(keyBadge(st("missing", null), meta, "10+ characters").placeholder).toBe("10+ characters");
    expect(keyBadge(st("keychain", null, true), meta, "10+ characters").placeholder).toBe("Replace…");
    expect(keyBadge(undefined, null).label).toBe("…");
  });
});

describe("secretInputError", () => {
  it("rejects empty and over-long values without echoing them", () => {
    expect(secretInputError("   ")).toMatch(/Paste/);
    expect(secretInputError("sk-test")).toBeNull();
    expect(secretInputError("a".repeat(MAX_SECRET_CHARS))).toBeNull();
    const e = secretInputError("a".repeat(MAX_SECRET_CHARS + 1))!;
    expect(e).toMatch(/1024/);
    expect(e).not.toMatch(/aaaa/);
  });
});

describe("withKeychain", () => {
  const src = (keys: Partial<Record<OsSecret, OsKeyStatus>>): OsKeySources => ({ keys: keys as Record<OsSecret, OsKeyStatus>, envFile: meta.envFile, envFileFound: true });

  it("flips a missing key to keychain on save and back on delete", () => {
    const s = src({ anthropic: st("missing", "ANTHROPIC_API_KEY") });
    const saved = withKeychain(s, "anthropic", true);
    expect(saved.keys.anthropic).toEqual(st("keychain", "ANTHROPIC_API_KEY", true));
    expect(withKeychain(saved, "anthropic", false).keys.anthropic).toEqual(st("missing", "ANTHROPIC_API_KEY", false));
    expect(s.keys.anthropic.source).toBe("missing"); // not mutated
  });

  it("keeps an env source and only records the fallback", () => {
    const s = src({ brave: st("env-file", "BRAVE_API_KEY") });
    expect(withKeychain(s, "brave", true).keys.brave).toEqual(st("env-file", "BRAVE_API_KEY", true));
  });

  it("leaves the Gmail pair's source to the reload", () => {
    const s = src({ "gmail-script-id": st("missing", "GMAIL_SCRIPT_ID", false, false) });
    expect(withKeychain(s, "gmail-script-id", true).keys["gmail-script-id"]).toEqual(st("missing", "GMAIL_SCRIPT_ID", true, false));
  });
});
