// src/lib/iros/memory.ts
// Iros Memory — Qコード履歴ベースのメモリー取得ユーティリティ
// - DB: user_q_now / q_code_timeline を参照して IrosMemory を構築する
// - 「コードは1つずつ」「見当で進めない」方針に合わせ、
//   テーブル名やカラム名は PDF に合わせて明示しつつ、
//   実際の差異にはある程度耐えられるマッピングにしている。

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { QCode } from './system';
import type { QSnapshot, QTrace, IrosMemory } from './memory/types';

// ====================== Supabase Admin Client ======================

let supabaseAdmin: SupabaseClient | null = null;

/**
 * サービスロールでの Supabase クライアントを取得。
 * - Next.js のサーバーサイド前提。
 * - 環境変数が未設定の場合はエラーを投げる。
 */
function getSupabaseAdmin(): SupabaseClient {
  if (supabaseAdmin) return supabaseAdmin;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    throw new Error(
      '[IrosMemory] SUPABASE 環境変数が不足しています。NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY を確認してください。'
    );
  }

  supabaseAdmin = createClient(url, serviceRoleKey, {
    auth: { persistSession: false },
  });

  return supabaseAdmin;
}

// ====================== 型定義（このファイル内の補助） ======================

/**
 * user_q_now から取得される1行をゆるく表現した型。
 * 実際のカラム名の揺れに対応するため any を許容しつつ、
 * 主要カラムへのアクセスはヘルパー関数で行う。
 */
type UserQNowRow = {
  user_code: string;
  [key: string]: any;
};

/**
 * q_code_timeline から取得される1行。
 * PDF 上の説明に合わせて created_at / q / stage を参照する。
 */
type QTimelineRow = {
  created_at: string | null;
  q: QCode | null;
  stage: string | null;
  // 他にも source_type / intent / user_code などがある想定だがここでは使わない
  [key: string]: any;
};

// ====================== スナップショット組み立て ======================

/**
 * user_q_now の1行から QSnapshot を構築する。
 * - currentQ: currentq / q / q_code のいずれか
 * - depthStage: depthstage / stage のいずれか
 * - updatedAt: updated_at / created_at のいずれか
 */
function mapSnapshot(row: UserQNowRow | null): QSnapshot {
  if (!row) {
    return {
      currentQ: null,
      depthStage: null,
      updatedAt: null,
    };
  }

  const currentQ =
    (row.currentq ?? row.q ?? row.q_code ?? null) as QCode | null;

  const depthStage =
    (row.depthstage ?? row.stage ?? null) as string | null;

  const updatedAt =
    (row.updated_at ?? row.created_at ?? null) as string | null;

  return {
    currentQ,
    depthStage,
    updatedAt,
  };
}

/**
 * q_code_timeline の配列とスナップショットから QTrace を構築する。
 * - rows は created_at の降順（新しい順）で渡される想定。
 */
function buildQTraceFromRows(
  snapshot: QSnapshot,
  rows: QTimelineRow[]
): QTrace {
  const counts: Partial<Record<QCode, number>> = {};
  let streakQ: QCode | null = null;
  let streakLength = 0;
  let lastEventAt: string | null = null;

  if (rows.length > 0) {
    lastEventAt = rows[0]?.created_at ?? null;
  }

  let currentStreakQ: QCode | null = null;
  let currentLength = 0;

  for (const row of rows) {
    const q = row.q as QCode | null;
    if (!q) continue;

    // ヒストグラム集計
    counts[q] = (counts[q] ?? 0) + 1;

    // 先頭から見ていき、連続している Q を streak とみなす
    if (currentStreakQ === null) {
      currentStreakQ = q;
      currentLength = 1;
    } else if (q === currentStreakQ) {
      currentLength += 1;
    } else {
      // 最初の Q から違う Q が出たら streak をそこで打ち切る
      break;
    }
  }

  streakQ = currentStreakQ;
  streakLength = currentLength;

  return {
    snapshot,
    counts,
    streakQ,
    streakLength,
    lastEventAt,
  };
}

/**
 * userCode がまだ一度も Qコードを記録していない場合に使う空メモリー。
 */
function createEmptyMemory(userCode: string): IrosMemory {
  const snapshot: QSnapshot = {
    currentQ: null,
    depthStage: null,
    updatedAt: null,
  };

  const trace: QTrace = {
    snapshot,
    counts: {},
    streakQ: null,
    streakLength: 0,
    lastEventAt: null,
  };

  return {
    userCode,
    qTrace: trace,
  };
}

// ====================== 公開関数：読み出し ======================

/**
 * 指定ユーザーの Qコード履歴に基づく IrosMemory を取得する。
 *
 * - user_q_now から「最新スナップショット」を1件取得
 * - q_code_timeline から「直近 limit 件」の履歴を取得
 * - それらを統合して QTrace / IrosMemory を返す
 *
 * @param userCode - DB 上の user_code
 * @param limit    - 直近履歴の最大件数（デフォルト 50）
 */
export async function loadIrosMemory(
  userCode: string,
  limit: number = 50
): Promise<IrosMemory> {
  const sb = getSupabaseAdmin();

  // 1) user_q_now から最新スナップショットを取得
  const { data: snapRowRaw, error: snapError } = await sb
    .from('user_q_now')
    .select('*')
    .eq('user_code', userCode)
    .maybeSingle();

  const snapRow = snapRowRaw as UserQNowRow | null;

  if (snapError && snapError.code !== 'PGRST116') {
    // PGRST116 = Row not found (maybeSingle の「0件」) を許容
    console.warn('[IrosMemory] user_q_now 取得時エラー:', snapError.message);
  }

  const snapshot = mapSnapshot(snapRow ?? null);

  // 2) q_code_timeline から直近履歴を取得
  const { data: rows, error: timelineError } = await sb
    .from('q_code_timeline')
    .select('created_at,q,stage')
    .eq('user_code', userCode)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (timelineError) {
    console.warn(
      '[IrosMemory] q_code_timeline 取得時エラー:',
      timelineError.message
    );
  }

  const timelineRows: QTimelineRow[] = (rows ?? []) as QTimelineRow[];

  // 3) QTrace を構築
  const qTrace = buildQTraceFromRows(snapshot, timelineRows);

  // 4) IrosMemory にまとめて返す
  const memory: IrosMemory = {
    userCode,
    qTrace,
  };

  return memory;
}

/**
 * IrosMemory をそのまま返すヘルパー。
 * - 将来的に「メモリーのマージ」や「タグ付け」などを行うときの拡張ポイント。
 */
export async function getIrosMemory(
  userCode: string,
  options?: { limit?: number }
): Promise<IrosMemory> {
  const limit = options?.limit ?? 50;
  try {
    return await loadIrosMemory(userCode, limit);
  } catch (e) {
    console.warn('[IrosMemory] loadIrosMemory 失敗。空メモリーを返します。', e);
    return createEmptyMemory(userCode);
  }
}

// 将来、QTrace だけ欲しいケース向けのショートカット
export async function getQTrace(
  userCode: string,
  options?: { limit?: number }
): Promise<QTrace> {
  const memory = await getIrosMemory(userCode, options);
  return memory.qTrace;
}

// ====================== 公開関数：保存（iros_memory_state） ======================

/**
 * saveIrosMemory
 *
 * 既存の route.ts との互換を保つため、
 * 引数は可変長 (...args) で受け取り、以下2パターンをサポートします。
 *
 *  1) saveIrosMemory(userCode, memory, qTrace?)
 *     - userCode: string
 *     - memory : src/lib/iros/memory/types.ts の IrosMemory 相当
 *     - qTrace : QTrace（省略可）
 *
 *  2) saveIrosMemory({ userCode, memory, qTrace })
 *     - 1つのオブジェクトで渡すパターン
 *
 * どちらでも最終的に userCode / summary / depth などに正規化して
 * iros_memory_state テーブルに UPSERT します。
 */
export async function saveIrosMemory(...args: any[]): Promise<void> {
  try {
    if (!args || args.length === 0) {
      console.warn('[IrosMemory] saveIrosMemory called with no args');
      return;
    }

    // -------- 引数正規化 --------
    let userCode: string | undefined;
    let memory: any = {};
    let qTrace: QTrace | undefined;

    if (args.length === 1 && typeof args[0] === 'object') {
      // パターン 2) saveIrosMemory({ userCode, memory, qTrace })
      const payload = args[0] ?? {};
      userCode = payload.userCode ?? payload.user_code;
      memory = payload.memory ?? {};
      qTrace = payload.qTrace ?? payload.trace;
    } else {
      // パターン 1) saveIrosMemory(userCode, memory, qTrace?)
      userCode = args[0];
      memory = args[1] ?? {};
      qTrace = args[2];
    }

    if (!userCode || typeof userCode !== 'string') {
      console.warn(
        '[IrosMemory] saveIrosMemory: userCode が取得できなかったため保存をスキップします'
      );
      return;
    }

    // -------- フィールド抽出 --------
    const summary: string | null = memory.summary ?? null;
    const depthStage: string | null =
      memory.depth ??
      memory.depth_stage ??
      qTrace?.snapshot.depthStage ??
      null;

    const tone: string | null = memory.tone ?? null;
    const theme: string | null = memory.theme ?? null;
    const lastKeyword: string | null =
      memory.last_keyword ?? memory.lastKeyword ?? null;

    const qPrimary: string | null = qTrace?.snapshot.currentQ ?? null;
    const qCounts: Record<string, number> | null =
      (qTrace?.counts as Record<string, number> | undefined) ?? null;

    const sb = getSupabaseAdmin();

    const { error } = await sb
      .from('iros_memory_state')
      .upsert(
        {
          user_code: userCode,
          summary,
          depth_stage: depthStage,
          tone,
          theme,
          last_keyword: lastKeyword,
          q_primary: qPrimary,
          q_counts: qCounts,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'user_code' } // user_code ごとに1行だけ維持
      );

    if (error) {
      console.error('[IrosMemory] saveIrosMemory upsert error:', error);
    }
  } catch (e) {
    console.error('[IrosMemory] saveIrosMemory exception:', e);
  }
}
