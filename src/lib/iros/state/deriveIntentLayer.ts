// src/lib/iros/state/deriveIntentLayer.ts
export type IntentLayer = 'S' | 'R' | 'C' | 'I' | 'T';

export function deriveIntentLayer(depthStage: string | null | undefined): IntentLayer | null {
  const s = String(depthStage ?? '').trim();
  if (!s) return null;

  const head = s[0]?.toUpperCase();
  if (head === 'S' || head === 'R' || head === 'C' || head === 'I' || head === 'T') return head;

  return null;
}
