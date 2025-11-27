// src/app/api/agent/iros/reply/_mode.ts
// Iros Reply 用：モード判定 & Remember スコープ判定ユーティリティ

import type { RememberScopeKind } from '@/lib/iros/remember/resolveRememberBundle';

export type IrosModeHint = 'structured' | 'diagnosis' | 'counsel' | 'auto';

/** テキストなどから Iros のモードヒントを推定する */
export function resolveModeHintFromText(input?: {
  modeHint?: string | null;
  hintText?: string | null;
  text?: string | null;
}): IrosModeHint {
  const direct = (input?.modeHint ?? '').toLowerCase().trim();
  if (direct === 'structured' || direct === 'diagnosis' || direct === 'counsel') return direct;

  const hint = (input?.hintText ?? '').toLowerCase();
  if (hint.includes('structured')) return 'structured';
  if (hint.includes('diagnosis') || hint.includes('ir診断') || hint.includes('診断')) return 'diagnosis';

  const t = (input?.text ?? '').toLowerCase();

  // 日本語の“構造化/レポート系”キーワードで structured 扱い
  const structuredJa = [
    'レポート形式',
    'レポートで',
    'レポートを',
    '構造化',
    'フェーズ立て',
    '箇条書き',
    '要件をまとめ',
    '要件整理',
    '要約して',
    '表にして',
    '一覧化',
    '整理して出して',
    'レポートとしてまとめ',
  ];
  if (structuredJa.some((k) => t.includes(k))) return 'structured';

  if (t.includes('相談') || t.includes('悩み') || t.includes('困って')) return 'counsel';

  return 'auto';
}

/** Rememberモードのスコープ検出（modeHint / テキストから） */
export function resolveRememberScope(input?: {
  modeHint?: string | null;
  hintText?: string | null;
  text?: string | null;
}): RememberScopeKind | null {
  const direct = (input?.modeHint ?? '').toLowerCase().trim();

  // 明示モード指定
  if (direct === 'remember') return 'lastWeek';
  if (direct === 'remember-yesterday') return 'yesterday';
  if (direct === 'remember-lastweek' || direct === 'remember-week') return 'lastWeek';
  if (direct === 'remember-lastmonth' || direct === 'remember-month') return 'lastMonth';

  const t = (input?.text ?? '').toLowerCase();
  if (!t) return null;

  // ゆるいキーワード検出
  if (t.includes('昨日の')) return 'yesterday';
  if (t.includes('昨日') && t.includes('あれ')) return 'yesterday';
  if (t.includes('先週の') || t.includes('先週')) return 'lastWeek';
  if (t.includes('先月の') || t.includes('先月')) return 'lastMonth';
  if (t.includes('remember') || t.includes('リメンバー')) return 'lastWeek';
  if (t.includes('前の相談') || t.includes('前に話した')) return 'lastWeek';

  return null;
}
