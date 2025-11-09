// src/lib/iros/trigger.ts
export type IrosMode = 'diagnosis' | 'intent' | 'normal';

const DIAG = /\bir\b|ir診断|irで見てください|ランダムでirお願いします|ir共鳴フィードバック/i;
const INTENT = /(意図トリガー|(?<![ぁ-んァ-ン一-龠a-zA-Z0-9])意図(?![ぁ-んァ-ン一-龠a-zA-Z0-9]))/;

export function detectIrosMode(input: string): IrosMode {
  if (DIAG.test(input)) return 'diagnosis';
  if (INTENT.test(input)) return 'intent';
  return 'normal';
}
