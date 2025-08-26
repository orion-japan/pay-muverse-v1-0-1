// src/lib/visionAutoPause.ts
export type PhaseKey = 'initial' | 'mid' | 'final';

export const PAUSE_THRESHOLD_DAYS: Record<PhaseKey, number> = {
  initial: 14,  // 初期は短く
  mid: 21,      // 中期は中間
  final: 28,    // 後期は粘る
};

export const isOverdue = (lastActivityAt?: string | null, phase: PhaseKey = 'initial') => {
  const days = PAUSE_THRESHOLD_DAYS[phase];
  if (!days) return false;
  const last = lastActivityAt ? new Date(lastActivityAt).getTime() : 0;
  const now = Date.now();
  const ms = days * 24 * 60 * 60 * 1000;
  return now - last > ms;
};
