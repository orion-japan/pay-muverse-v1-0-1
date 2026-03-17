// src/lib/iros/language/shortFixedPhrase.ts

export type ShortFixedPhraseKind =
  | 'greeting'
  | 'thanks'
  | 'fatigue'
  | 'courtesy'
  | 'other';

function normalizeCore(input: string): string {
  return String(input ?? '')
    .replace(/\s+/g, '')
    .trim()
    .toLowerCase();
}

type FixedPhraseEntry = {
  kind: ShortFixedPhraseKind;
  pattern: RegExp;
  canonical: string;
  reply: string;
};

const FIXED_PHRASES: FixedPhraseEntry[] = [
  {
    kind: 'greeting',
    pattern: /^(おはよう|おはようございます)$/iu,
    canonical: 'おはようございます',
    reply: 'おはようございます。🪔',
  },
  {
      kind: 'greeting',
      pattern: /^(こんにちは|こんにちわ|こんちは|こんちわ)$/iu,
      canonical: 'こんにちは',
      reply: 'こんにちは。🪔',
    },
  {
    kind: 'greeting',
    pattern: /^(こんばんは|こんばんわ|今晩は)$/iu,
    canonical: 'こんばんは',
    reply: 'こんばんは。🪔',
  },
  {
    kind: 'greeting',
    pattern: /^(やあ|hi|hello)$/iu,
    canonical: 'こんにちは',
    reply: 'こんにちは。🪔',
  },
  {
    kind: 'courtesy',
    pattern: /^(はじめまして|初めまして)$/iu,
    canonical: 'はじめまして',
    reply: 'はじめまして。🪔',
  },
  {
    kind: 'courtesy',
    pattern: /^(よろしく|宜しく|よろしくお願いします)$/iu,
    canonical: 'よろしくお願いします',
    reply: 'よろしくお願いします。🪔',
  },
  {
    kind: 'thanks',
    pattern: /^(ありがとう|ありがとうございます|どうも)$/iu,
    canonical: 'ありがとうございます',
    reply: 'ありがとうございます。🪔',
  },
  {
    kind: 'fatigue',
    pattern: /^(お疲れ|おつかれ|お疲れさま|おつかれさま)$/iu,
    canonical: 'おつかれさま',
    reply: 'おつかれさまです。🪔',
  },
];

export function getShortFixedPhrase(text: string): {
  ok: true;
  kind: ShortFixedPhraseKind;
  canonical: string;
  reply: string;
  normalized: string;
} | null {
  const normalized = normalizeCore(text);
  if (!normalized) return null;

  for (const row of FIXED_PHRASES) {
    if (row.pattern.test(normalized)) {
      return {
        ok: true,
        kind: row.kind,
        canonical: row.canonical,
        reply: row.reply,
        normalized,
      };
    }
  }

  return null;
}

export function isShortFixedPhrase(text: string): boolean {
  return getShortFixedPhrase(text) !== null;
}

export function isShortGreetingLike(text: string): boolean {
  const hit = getShortFixedPhrase(text);
  return hit?.kind === 'greeting' || hit?.kind === 'courtesy';
}
