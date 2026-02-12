// src/lib/iros/server/handleIrosReply.goalRecall.ts
// iros — goal recall helpers (extracted from handleIrosReply.ts)
//
// 目的：goal recall 判定と「履歴から今日の目標っぽい文」を抽出する処理を分離
// 方針：
// - stringify しない（[object Object] を作らない）
// - 入力は (text, history) のみ。外部依存を持たない

function norm(v: any): string {
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

function toText(v: any): string {
  if (typeof v === 'string') return v;
  if (v == null) return '';

  if (Array.isArray(v)) {
    return v
      .map((p) => {
        if (typeof p === 'string') return p;
        if (p?.type === 'text' && typeof p?.text === 'string') return p.text;
        if (typeof p?.text === 'string') return p.text;
        if (typeof p?.content === 'string') return p.content;
        return '';
      })
      .filter(Boolean)
      .join(' ');
  }

  if (typeof v === 'object') {
    if (typeof (v as any).text === 'string') return (v as any).text;
    if (typeof (v as any).content === 'string') return (v as any).content;
  }

  return '';
}

function isGoalRecallQuestion(s: string): boolean {
  return (
    /(今日の目標|目標|ゴール|goal).*(覚えてる|なんだっけ|何\?|何？|教えて)/i.test(s) ||
    /^(今日の目標|目標|ゴール|goal)\s*(は|って|を)?\s*(\?|？)$/.test(s)
  );
}

function isGoalStatement(s: string): boolean {
  if (isGoalRecallQuestion(s)) return false;

  if (
    /^(今日は|今日|本日)/.test(s) &&
    /(する|やる|直す|実装|確認|整理|調査|再現|通す|分割|移行|追加|削除|テスト)/.test(s)
  ) {
    return true;
  }

  if (/(今日の目標|目標|ゴール|goal)\s*(は|:|：)/i.test(s)) return true;

  return false;
}

function cleanupGoalCandidate(raw: unknown): string | null {
  let out = norm(raw);
  if (!out) return null;

  if (out === '[object Object]' || out.includes('[object Object]')) return null;

  out = out.replace(/^今日の目標は[「『"]?/g, '');
  out = out.replace(/[」』"]?です[。\.！!]?$/g, '');

  out = out.replace(/^[\s「『"'\(\[\{、,，。．・:：\-—–]+/g, '');
  out = out.replace(/[\s」』"'\)\]\}、,，。．・]+$/g, '');

  out = out.trim();
  if (!out) return null;
  if (out.length <= 2) return null;

  return out;
}

export function isGoalRecallQ(text: string): boolean {
  const s = String(text ?? '').trim();
  return /^(?:今日の)?(?:目標|ゴール)\s*(?:覚えてる|覚えてる\?|覚えてる？|なんだっけ|なんだっけ\?|なんだっけ？|何だっけ|何だっけ\?|何だっけ？|って何|は何|教えて)/.test(
    s,
  );
}

export function extractGoalFromHistory(history: any[]): string | null {
  const arr = Array.isArray(history) ? history : [];
  const fallback: string[] = [];

  for (let i = arr.length - 1; i >= 0; i--) {
    const m = arr[i];
    const role = String(m?.role ?? '').toLowerCase();
    if (role !== 'user') continue;

    const t = norm(toText(m?.content ?? m?.text ?? (m as any)?.message ?? ''));
    if (!t) continue;

    const cleaned = cleanupGoalCandidate(t);
    if (!cleaned) continue;

    if (isGoalRecallQuestion(cleaned)) continue;
    if (/\?$|？$/.test(cleaned)) continue;

    if (isGoalStatement(cleaned)) return cleaned;
    fallback.push(cleaned);
  }

  return fallback.length ? fallback[0] : null;
}
