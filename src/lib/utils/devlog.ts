// src/lib/utils/devlog.ts
// devlog / devwarn — 開発時限定ログ出力（IROS_DEBUG=1のときのみ）
// - 本番では自動的に沈黙（isServerOnly=true指定でサーバ側限定出力）
// - import { devlog, devwarn } from '@/lib/utils/devlog';

const DEBUG = process.env.IROS_DEBUG === '1';

/**
 * devlog
 * @param label ログ名
 * @param data 任意データ
 * @param opts scope?: string / isServerOnly?: boolean
 */
export function devlog(
  label: string,
  data?: unknown,
  opts?: { scope?: string; isServerOnly?: boolean },
): void {
  if (!DEBUG) return;
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
  opts?: { scope?: string; isServerOnly?: boolean },
): void {
  if (!DEBUG) return;
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
