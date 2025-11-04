// src/lib/iros/intent.ts
export type Mode = 'Light' | 'Deep' | 'Transcend';

export function detectWantsStructure(text: string): boolean {
  return /(ir診断|意図トリガー|構造出力|闇の物語)/.test(text);
}

export function detectIsDark(text: string): boolean {
  return /(闇の物語)/.test(text);
}

export function deriveFinalMode(requested: Mode, text: string): Mode {
  // 「闇の物語」は少し深めに
  return detectIsDark(text) ? (requested === 'Light' ? 'Deep' : requested) : requested;
}
