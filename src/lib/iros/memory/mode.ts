// src/lib/iros/memory/mode.ts
export type IrosMode = 'Auto' | 'Reflect' | 'Resonate' | 'Diagnosis' | 'Intention';

export function detectMode(userText: string): IrosMode {
  const t = (userText || '').trim();

  if (/^\s*(ir\s*診断|ir診断|irで見て|ir\s*お願いします)/i.test(t)) {
    return 'Diagnosis';
  }
  if (/意図(トリガー)?/i.test(t)) {
    return 'Intention';
  }
  // 明示がなければAuto
  return 'Auto';
}
