// 期日（結果→自動移管）
export type PhaseKey = 'initial' | 'mid' | 'final';

export const AUTO_ARCHIVE_DAYS: Record<PhaseKey, number> = {
  initial: 7,   // 初期：7日
  mid: 14,      // 中期：14日
  final: 21,    // 後期：21日
};

export function isArchiveDue(resultedAt?: string | null, phase?: string | null) {
  if (!resultedAt) return false;
  const p = (phase as PhaseKey) || 'initial';
  const days = AUTO_ARCHIVE_DAYS[p] ?? 7;
  const base = new Date(resultedAt).getTime();
  const now = Date.now();
  return now - base > days * 24 * 60 * 60 * 1000;
}
