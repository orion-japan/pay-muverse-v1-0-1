// src/lib/utils/devlog.ts
// devlog / devwarn — 開発時限定ログ出力
// - 本番（NODE_ENV=production）では必ず沈黙
// - 開発時でも IROS_DEBUG=1 のときのみ出力
// - import { devlog, devwarn } from '@/lib/utils/devlog';

const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const DEBUG = !IS_PRODUCTION && process.env.IROS_DEBUG === '1';

type DevLogOptions = {
  scope?: string;
  isServerOnly?: boolean;
};

function shouldSkip(opts?: DevLogOptions): boolean {
  if (!DEBUG) return true;
  if (opts?.isServerOnly && typeof window !== 'undefined') return true;
  return false;
}

/**
 * devlog
 * @param label ログ名
 * @param data 任意データ
 * @param opts scope?: string / isServerOnly?: boolean
 */
export function devlog(
  label: string,
  data?: unknown,
  opts?: DevLogOptions,
): void {
  if (shouldSkip(opts)) return;

  const prefix = opts?.scope ? `[${opts.scope}]` : '';
  const ts = new Date().toISOString();
  const where = opts?.isServerOnly ? '(server)' : '';

  try {
    console.log(`${ts} ${where}${prefix} ${label}`, data ?? '');
  } catch {
    // ignore
  }
}

/**
 * devwarn — 警告ログ
 * @param label ラベル
 * @param detail 詳細（例外や文字列）
 * @param opts 任意スコープ
 */
export function devwarn(
  label: string,
  detail?: unknown,
  opts?: DevLogOptions,
): void {
  if (shouldSkip(opts)) return;

  const prefix = opts?.scope ? `[${opts.scope}]` : '';
  const ts = new Date().toISOString();
  const where = opts?.isServerOnly ? '(server)' : '';

  try {
    console.warn(`${ts} ${where}${prefix} ⚠ ${label}`, detail ?? '');
  } catch {
    // ignore
  }
}

export default { devlog, devwarn };
