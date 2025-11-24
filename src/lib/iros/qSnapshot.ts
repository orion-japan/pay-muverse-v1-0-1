// src/lib/iros/qSnapshot.ts
// user_q_now テーブルに「いまのQ／深度」のスナップショットを保持する軽量キャッシュ

import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Iros の meta から「現在の Q / 深度」を抜き出し、
 * user_q_now テーブルに反映する。
 *
 * テーブル定義（実テーブルに合わせる）:
 *   table: user_q_now
 *   - user_code  text
 *   - currentq   text        ← current_q ではない
 *   - depthstage text        ← depth_stage ではない
 *   - updated_at timestamp
 */
export async function updateUserQNowFromMeta(
  supabase: SupabaseClient,
  userCode: string | null | undefined,
  meta: any,
): Promise<void> {
  if (!supabase) {
    console.error('[Iros/updateUserQNowFromMeta] supabase client is required');
    return;
  }
  if (!userCode) {
    // user_code が取れないときは何もしない
    return;
  }
  if (!meta || typeof meta !== 'object') {
    // meta がない場合も何もしない（エラーにはしない）
    return;
  }

  // ---- meta から q / depth を抽出（できるだけ柔軟に） ----
  const rawQ =
    meta.qCode ??
    meta.q_code ??
    meta.unified?.q?.current ??
    meta.unified?.q?.code ??
    null;

  const rawDepth =
    meta.depth ??
    meta.depth_stage ??
    meta.unified?.depth?.stage ??
    null;

  const qCode: string | null =
    typeof rawQ === 'string' && rawQ.trim().length > 0 ? rawQ.trim() : null;

  const depthStage: string | null =
    typeof rawDepth === 'string' && rawDepth.trim().length > 0 ? rawDepth.trim() : null;

  // どちらも取れないなら何もしない
  if (!qCode && !depthStage) {
    return;
  }

  try {
    // 既存レコードがあるか確認
    const { data: existing, error: selectErr } = await supabase
      .from('user_q_now')
      .select('*')
      .eq('user_code', userCode)
      .maybeSingle();

    if (selectErr) {
      console.error('[Iros/updateUserQNowFromMeta] select error:', selectErr);
      // select に失敗しても致命傷ではないので return
      return;
    }

    const nowIso = new Date().toISOString();

    const nextRow = {
      user_code: userCode,
      // 実テーブルのカラム名に合わせる（currentq / depthstage）
      currentq: qCode ?? existing?.currentq ?? null,
      depthstage: depthStage ?? existing?.depthstage ?? null,
      updated_at: nowIso,
    };

    const { error: upsertErr } = await supabase.from('user_q_now').upsert(nextRow, {
      onConflict: 'user_code',
    });

    if (upsertErr) {
      console.error('[Iros/updateUserQNowFromMeta] upsert error:', upsertErr);
      return;
    }

    // 正常時はログは静かにしておくか、必要なら debug だけ
    // console.log('[Iros/updateUserQNowFromMeta] updated', nextRow);
  } catch (e) {
    console.error('[Iros/updateUserQNowFromMeta] unexpected error:', e);
  }
}
