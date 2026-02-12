// src/lib/iros/server/handleIrosReply.recallFilter.ts
// iros — generic recall filter helpers (extracted from handleIrosReply.ts)
//
// 目的：runGenericRecallGate に渡す history の「採用/除外」条件を切り出して
// handleIrosReply.ts を軽量化する
// 方針：
// - stringify しない（[object Object] を作らない）
// - 入力は history のみ。外部依存を持たない
// - “元の要素”を返す（型や形を変えない）

function normForRecall(v: any): string {
  if (v == null) return '';

  if (Array.isArray(v)) {
    const parts = v
      .map((p) => {
        if (typeof p === 'string') return p;
        if (!p) return '';
        if (typeof p === 'object') {
          if (typeof (p as any).text === 'string') return (p as any).text;
          if (typeof (p as any).content === 'string') return (p as any).content;
          if (typeof (p as any).value === 'string') return (p as any).value;
          if (typeof (p as any).message === 'string') return (p as any).message;
        }
        return '';
      })
      .filter(Boolean)
      .join(' ');
    return parts.replace(/\s+/g, ' ').trim();
  }

  if (typeof v === 'string') return v.replace(/\s+/g, ' ').trim();

  if (typeof v === 'object') {
    const t =
      (typeof (v as any).text === 'string' && (v as any).text) ||
      (typeof (v as any).content === 'string' && (v as any).content) ||
      (typeof (v as any).message === 'string' && (v as any).message) ||
      '';
    return String(t).replace(/\s+/g, ' ').trim();
  }

  return String(v).replace(/\s+/g, ' ').trim();
}

export function filterHistoryForGenericRecall(history: unknown[]): any[] {
  const arr = Array.isArray(history) ? (history as any[]) : [];

  return arr
    .filter((m) => String(m?.role ?? '').toLowerCase() === 'user')
    .filter((m) => {
      const s = normForRecall(m?.content ?? m?.text ?? (m as any)?.message ?? '');
      if (!s) return false;

      // “recall の返し文っぽい” ものは混ぜない（循環防止）
      if (/^たぶんこれのことかな\s*[:：]/.test(s)) return false;

      // 事故混入は確実に落とす
      if (s === '[object Object]' || s.includes('[object Object]')) return false;

      return true;
    });
}
