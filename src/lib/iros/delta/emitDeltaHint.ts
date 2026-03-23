import type { PrimaryDelta } from './types';

export function emitDeltaHint(delta: PrimaryDelta | null): string | null {
  if (!delta) return null;

  switch (delta.type) {
    case 'energy': {
      const from = String((delta.payload as any)?.from ?? '').trim() || 'unknown';
      const to = String((delta.payload as any)?.to ?? '').trim() || 'unknown';
      return `@DELTA energy_shift: e_turn が ${from} → ${to} に変化`;
    }

    case 'intent': {
      const from = String((delta.payload as any)?.from ?? '').trim() || 'unknown';
      const to = String((delta.payload as any)?.to ?? '').trim() || 'unknown';
      return `@DELTA intent_shift: 意図ラインが ${from} → ${to} に変化`;
    }

    case 'structure': {
      const from =
        String((delta.payload as any)?.prevTopic ?? '').trim() || 'unknown';
      const to =
        String((delta.payload as any)?.nextTopic ?? '').trim() || 'unknown';
      return `@DELTA structure_shift: 話題軸が ${from} → ${to} に変化`;
    }

    default:
      return null;
  }
}
