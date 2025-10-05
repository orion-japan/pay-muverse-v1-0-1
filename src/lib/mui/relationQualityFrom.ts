// src/lib/mui/relationQualityFrom.ts
import type { Phase, SelfBand, RelationQuality } from '@/lib/mui/types';

export function relationQualityFrom(phase: Phase, band: SelfBand): RelationQuality {
  // 簡易ロジック（必要に応じて強化）
  if (band === 'lt20' || band === '10_40') return { label: 'discord', confidence: 0.7 };
  if (band === '70_90' || band === 'gt90') return { label: 'harmony', confidence: 0.7 };
  return { label: 'harmony', confidence: 0.5 };
}
