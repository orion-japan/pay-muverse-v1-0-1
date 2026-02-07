// src/app/api/agent/iros/reply/_mode.ts
// Iros Reply 用：モード判定 & Remember スコープ判定ユーティリティ

import type { RememberScopeKind } from '@/lib/iros/remember/resolveRememberBundle';

export type IrosModeHint = 'structured' | 'diagnosis' | 'counsel' | 'auto';

function isIrDiagnosisCommand(rawText: string): boolean {
  const trimmed = String(rawText ?? '').trim();
  if (!trimmed) return false;

  const lower = trimmed.toLowerCase();

  // ✅ "iros" は絶対に除外（先頭一致で弾く）
  if (lower.startsWith('iros')) return false;

  // ✅ 空白除去で "ir 診断" → "ir診断" を吸収
  const compact = trimmed.replace(/\s/g, '');
  const lowerCompact = compact.toLowerCase();

  // ✅ 代表コマンド（行頭）
  // - "ir"
  // - "ir診断..."
  // - "ir: ..." / "ir：..." / "ir ..." など（ただし "iros" は上で除外済み）
  if (lowerCompact === 'ir') return true;
  if (lowerCompact === 'ir診断' || lowerCompact.startsWith('ir診断')) return true;

  // "ir " / "ir　" / "ir:" / "ir：" / "ir\t" / "ir\n" など（行頭のみ）
  if (/^(?:ir|ｉｒ)(?:[　\s]+|[:：]|$)/i.test(trimmed)) return true;

  // 日本語フレーズ（行頭以外に含まれてもOKにしたいものだけ）
  // ※誤爆を避けたいので、ここは必要最小限
  if (lower.includes('irで見て') || lower.includes('irでみて')) return true;
  if (lower.includes('irお願いします')) return true;
  if (lower.includes('ir共鳴フィードバック')) return true;

  return false;
}

/** テキストなどから Iros のモードヒントを推定する */
export function resolveModeHintFromText(input?: {
  modeHint?: string | null;
  hintText?: string | null;
  text?: string | null;
}): IrosModeHint {
  const direct = (input?.modeHint ?? '').toLowerCase().trim();
  if (direct === 'structured' || direct === 'diagnosis' || direct === 'counsel') return direct;

  // ✅ hintText は “自動でモードを決めない”
  // - ここがあると中途半端に structured/diagnosis に入りやすい
  // - 専用ターンが無い限り、入口判定を増やさない

  const rawText = String(input?.text ?? '');
  const t = rawText.toLowerCase();

  // ✅ ir診断コマンドだけは text から拾って diagnosis
  // - "iros" は除外済み
  if (isIrDiagnosisCommand(rawText)) return 'diagnosis';

  // counsel は軽いキーワードのみ（必要なら後で専用ターン化）
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
