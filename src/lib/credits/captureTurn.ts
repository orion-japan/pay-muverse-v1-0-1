// src/lib/credits/captureTurn.ts
import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SERVICE_ROLE } from '@/lib/authz';

function sbService() {
  if (!SUPABASE_URL || !SERVICE_ROLE) throw new Error('Supabase env is missing');
  return createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });
}

/** 会話1ターンの確定課金（idempotency_key 必須） */
export async function captureTurnViaRPC(opts: {
  userCode: string;
  amount: number;                  // 例: 1
  idempotencyKey: string;          // 例: sub_id や `${convId}:${ts}`
  reason: string;                  // 例: 'mu_chat_turn'
  meta?: Record<string, any>;      // { agent:'mu', model:'gpt-4o-mini' } 等
  refConversationId?: string;      // 会話コード/ID
}) {
  const sb = sbService();
  const { userCode, amount, idempotencyKey, reason, meta, refConversationId } = opts;

  const { data, error } = await sb.rpc('mu_capture_credit', {
    p_user_code: String(userCode),
    p_amount: Number(amount),
    p_idempotency_key: String(idempotencyKey),
    p_reason: String(reason),
    p_meta: meta ?? {},
    p_ref_conversation_id: refConversationId ? String(refConversationId) : null,
  });

  if (error) {
    const msg = String(error.message || error);
    if (/insufficient/i.test(msg)) return { ok: false as const, code: 402, error: 'insufficient_credit' };
    return { ok: false as const, code: 500, error: 'capture_failed', detail: msg };
  }

  const balance =
    typeof data === 'number' || typeof data === 'string' ? Number(data) : null;

  return { ok: true as const, balance };
}
