import { createClient } from '@supabase/supabase-js';
import type { QRes } from './types';

// SR で安全に保存
export async function saveQRes(
  sbUrl: string,
  srKey: string,
  user_code: string,
  qres: QRes,
  source_type: string, // 'mirra'|'mu'|'replay'|'event'|'self'|'comment'|'vision'|'vision_progress'|'vision_journal'
  intent: string = 'chat', // 'chat'|'post'|'diary'|'progress' など
) {
  const sb = createClient(sbUrl, srKey, { auth: { persistSession: false } });
  // 履歴 追記
  const ins = await sb.from('q_code_logs').insert({
    user_code,
    source_type,
    intent,
    q_code: qres,
  });
  if (ins.error) throw new Error(`q_code_logs insert_failed: ${ins.error.message}`);

  // 最新 上書き
  const up = await sb.from('user_q_codes').upsert(
    {
      user_code,
      q_code: qres,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_code' },
  );
  if (up.error) throw new Error(`user_q_codes upsert_failed: ${up.error.message}`);
}
