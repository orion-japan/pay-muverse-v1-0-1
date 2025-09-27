// src/tests/muPrompt.spec.ts
import { describe, it, expect } from "vitest";
import { buildMuSystemPrompt } from "../lib/mu/buildSystemPrompt";
import { normalizeQ, buildQCode } from "../lib/qcodes";
import { checkToneAndLimits, enforcePoliteness } from "../lib/qcode/validators";

describe("Mu System Prompt", () => {
  it("should build default prompt string", () => {
    const p = buildMuSystemPrompt();
    expect(p).toContain("あなたは **Mu**");
    expect(p).toContain("Mu prompt version");
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

describe("Q code validation", () => {
  it("returns null for invalid hint strings", () => {
    expect(normalizeQ("abc" as any)).toBeNull();
    expect(normalizeQ("Q9")).toBeNull();
    expect(normalizeQ(undefined)).toBeNull();
  });

  it("falls back when buildQCode receives an invalid hint", () => {
    const built = buildQCode({ hint: "unknown", fallback: "Q3", depth_stage: "S1" });
    expect(built.current_q).toBe("Q3");
    expect(built.depth_stage).toBe("S1");
  });

  it("uses default fallback when none supplied", () => {
    const built = buildQCode({ hint: "", depth_stage: null });
    expect(built.current_q).toBe("Q2");
    expect(built.depth_stage).toBeNull();
  });
});
