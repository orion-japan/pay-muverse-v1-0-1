export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { verifyFirebaseAndAuthorize, SUPABASE_URL, SERVICE_ROLE } from '@/lib/authz';

const sb = () => createClient(SUPABASE_URL!, SERVICE_ROLE!);

const CORS_HEADERS: Record<string, string> = {
  'Content-Type': 'application/json; charset=utf-8',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-user-code, x-trace-id',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (data: any, status = 200) =>
  new NextResponse(JSON.stringify(data), { status, headers: CORS_HEADERS });

type FeedbackLabel = 'deep_hit' | 'good' | 'mismatch';

const FEEDBACK_TEXT: Record<FeedbackLabel, string> = {
  deep_hit: 'なんでわかるの？',
  good: 'イイね',
  mismatch: 'ちょっと違う',
};

function normalizeFeedbackLabel(v: unknown): FeedbackLabel | null {
  const s = String(v ?? '').trim();
  if (s === 'deep_hit' || s === 'good' || s === 'mismatch') return s;
  return null;
}

function pickUserCode(authz: any): string {
  return String(
    authz?.user?.user_code ??
      authz?.user?.uid ??
      authz?.userCode ??
      ''
  ).trim();
}

export async function OPTIONS() {
  return json({ ok: true });
}

export async function POST(req: NextRequest) {
  try {
    const authz = await verifyFirebaseAndAuthorize(req);

    if (!authz.ok) {
      return json({ ok: false, error: authz.error || 'unauthorized' }, authz.status || 401);
    }

    if (!authz.allowed) {
      return json({ ok: false, error: 'forbidden' }, 403);
    }

    const userCode = pickUserCode(authz);
    if (!userCode) {
      return json({ ok: false, error: 'user_code_missing' }, 400);
    }

    const body = await req.json().catch(() => ({}));

    const messageIdRaw = body?.messageId ?? body?.message_id;
    const messageId = Number(messageIdRaw);

    const conversationId =
      typeof body?.conversationId === 'string'
        ? body.conversationId
        : typeof body?.conversation_id === 'string'
          ? body.conversation_id
          : null;

    const feedbackLabel = normalizeFeedbackLabel(body?.feedbackLabel ?? body?.feedback_label);

    if (!Number.isFinite(messageId) || messageId <= 0) {
      return json({ ok: false, error: 'invalid_message_id' }, 400);
    }

    const supabase = sb();

    const { data: msg, error: msgErr } = await supabase
      .from('iros_messages')
      .select('id,user_code,conversation_id,role')
      .eq('id', messageId)
      .maybeSingle();

    if (msgErr) {
      return json({ ok: false, error: 'message_select_failed', detail: msgErr.message }, 500);
    }

    if (!msg) {
      return json({ ok: false, error: 'message_not_found' }, 404);
    }

    if (String((msg as any).user_code) !== String(userCode)) {
      return json({ ok: false, error: 'forbidden_owner_mismatch' }, 403);
    }

    if (String((msg as any).role) !== 'assistant') {
      return json({ ok: false, error: 'feedback_target_must_be_assistant' }, 400);
    }

    // feedbackLabel が null の場合は「取り消し」
    if (!feedbackLabel) {
      const { error: delErr } = await supabase
        .from('iros_message_feedback')
        .delete()
        .eq('message_id', messageId)
        .eq('user_code', userCode);

      if (delErr) {
        return json({ ok: false, error: 'feedback_delete_failed', detail: delErr.message }, 500);
      }

      return json({
        ok: true,
        action: 'deleted',
        messageId,
        feedbackLabel: null,
      });
    }

    const payload = {
      message_id: messageId,
      conversation_id: conversationId ?? (msg as any).conversation_id ?? null,
      user_code: userCode,
      feedback_label: feedbackLabel,
      feedback_text: FEEDBACK_TEXT[feedbackLabel],
      updated_at: new Date().toISOString(),
    };

    const { error: upsertErr } = await supabase
      .from('iros_message_feedback')
      .upsert(payload, { onConflict: 'message_id,user_code' });

    if (upsertErr) {
      return json({ ok: false, error: 'feedback_upsert_failed', detail: upsertErr.message }, 500);
    }

    return json({
      ok: true,
      action: 'upserted',
      messageId,
      feedbackLabel,
    });
  } catch (e: any) {
    return json({ ok: false, error: 'unhandled_error', detail: String(e?.message ?? e) }, 500);
  }
}
