// file: src/lib/q/logFromIros.ts
// Iros からの応答メタを Qコード基盤に記録するヘルパー
// - q_code_logs: イベントログ（時系列）
// - user_q_codes: 現在のQ / 深度スナップショット（view user_q_now で参照）

import { createClient } from '@supabase/supabase-js';
import type { Depth, QCode, IrosMeta } from '@/lib/iros/system';

// service-role で DB に書き込むクライアント
// （delete-post や reply ルートと同じ env 構成を前提）
const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
);

type LogQFromIrosArgs = {
  userCode: string;
  sourceType?: string;       // 例: 'iros'
  intent?: string;           // 例: 'normal' / 'iros_chat' など
  conversationId?: string;
  subId?: string;

  meta?: Pick<IrosMeta, 'qCode' | 'depth'>;
};

/**
 * Irosの応答メタから Qコードを抽出し、
 * - q_code_logs に1行追加
 * - user_q_codes を upsert（user_code 単位）
 */
export async function logQFromIros(args: LogQFromIrosArgs): Promise<void> {
  const {
    userCode,
    sourceType = 'iros',
    intent = 'iros_chat',
    conversationId,
    subId,
    meta,
  } = args;

  if (!userCode) {
    console.warn('[IROS/QLog] skip: userCode is empty');
    return;
  }

  const qCode = meta?.qCode as QCode | undefined;
  const depth = meta?.depth as Depth | undefined;

  // qCode / depth のどちらかでも欠けている場合は記録をスキップ
  if (!qCode || !depth) {
    console.warn('[IROS/QLog] skip: qCode or depth is missing', { userCode, qCode, depth });
    return;
  }

  const qJson = {
    currentQ: qCode,
    depthStage: depth,
  };

  // ========== 1) q_code_logs にイベントとして追加 ==========
  {
    const { error: logErr } = await supabaseAdmin.from('q_code_logs').insert({
      user_code: userCode,
      owner_user_code: userCode,
      actor_user_code: userCode,
      source_type: sourceType,
      intent,
      q_code: qJson,
      conversation_id: conversationId ?? null,
      sub_id: subId ?? null,
      // ほかの列（emotion / level / phase / self_acceptance / extra など）は
      // いまは触らず、必要になったら後から拡張する
    });

    if (logErr) {
      console.error('[IROS/QLog] insert q_code_logs error', logErr);
    }
  }

  // ========== 2) user_q_codes を upsert（user_code をキーに最新に上書き） ==========
  {
    const { error: upsertErr } = await supabaseAdmin
      .from('user_q_codes')
      .upsert(
        {
          user_code: userCode,
          source_type: sourceType,
          q_code: qJson,
          current_q: qCode,
          depth_stage: depth,
          updated_at: new Date().toISOString(),
          // s_ratio / r_ratio / c_ratio / i_ratio / traits / phase / self_acceptance などは
          // 既存値を壊さないように、ここでは指定しない
        },
        { onConflict: 'user_code' }, // ← UNIQUE(user_code) に対応
      );

    if (upsertErr) {
      console.error('[IROS/QLog] upsert user_q_codes error', upsertErr);
    }
  }
}
