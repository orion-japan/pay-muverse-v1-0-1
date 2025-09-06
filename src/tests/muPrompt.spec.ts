// src/tests/muPrompt.spec.ts
import { describe, it, expect } from "vitest";
import { buildMuSystemPrompt } from "../lib/mu/buildSystemPrompt";
import { checkToneAndLimits, enforcePoliteness } from "../lib/qcode/validators";

describe("Mu System Prompt", () => {
  it("should build default prompt string", () => {
    const p = buildMuSystemPrompt();
    expect(p).toContain("あなたは **Mu**");
    expect(p).toContain("1ターンに質問は最大1つ");
  });

  it("should respect override via param", () => {
    const override = "Mu override test";
    const p = buildMuSystemPrompt({ promptOverride: override });
    expect(p).toBe(override);
  });
});

describe("Tone and Limits", () => {
  it("should detect too many reasons", () => {
    const text = "理由があります。理由があります。";
    const res = checkToneAndLimits(text);
    expect(res.tooManyReasons).toBe(true);
  });

  it("should detect polite tone", () => {
    const polite = "これはテストです。よろしくお願いします。";
    expect(enforcePoliteness(polite)).toBe(true);
  });

  it("should detect non-polite tone", () => {
    const casual = "これはテストだ。頼む。";
    expect(enforcePoliteness(casual)).toBe(false);
  });
});
