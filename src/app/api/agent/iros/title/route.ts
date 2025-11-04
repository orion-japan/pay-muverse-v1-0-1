// src/app/api/agent/iros/title/route.ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { verifyFirebaseAndAuthorize, SUPABASE_URL, SERVICE_ROLE } from '@/lib/authz';

const sb = () => createClient(SUPABASE_URL!, SERVICE_ROLE!);

const json = (data: any, status = 200) =>
  new NextResponse(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
    },
  });

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const CHAT_URL = 'https://api.openai.com/v1/chat/completions';

export async function OPTIONS() {
  return json({ ok: true });
}

/** --------------------
 * POST /api/agent/iros/title
 * 本文: {
 *   conversation_id: string,
 *   model?: string,           // 既定: 'gpt-4o'
 *   lookback?: number         // 直近N件のメッセージから命名（既定: 20, 4..120）
 * }
 * 動作:
 *   - 所有者チェック → 直近N件の user/assistant を収集
 *   - LLMで 8〜14字・句読点なし のタイトル生成
 *   - iros_conversations.title を更新（列が無くてもエラー無視）
 *   - { title } を返す
 * -------------------- */
export async function POST(req: NextRequest) {
  try {
    if (!OPENAI_API_KEY) return json({ ok: false, error: 'missing_openai_api_key' }, 500);

    const authz = await verifyFirebaseAndAuthorize(req);
    if (!authz.ok) return json({ ok: false, error: authz.error }, authz.status || 401);
    if (!authz.allowed) return json({ ok: false, error: 'forbidden' }, 403);

    const userCode: string =
      (typeof authz.user === 'string' && authz.user) ||
      (typeof (authz.user as any)?.user_code === 'string' && (authz.user as any).user_code) ||
      (authz as any)?.userCode ||
      (authz as any)?.jwt?.sub ||
      '';

    if (!userCode) return json({ ok: false, error: 'user_code_missing' }, 400);

    let body: any = {};
    try { body = await req.json(); } catch { /* noop */ }

    const conversation_id: string = String(body?.conversation_id || body?.conversationId || '').trim();
    const model = String(body?.model || 'gpt-4o');
    const lookback = Math.max(4, Math.min(120, Number(body?.lookback ?? 20)));

    if (!conversation_id) return json({ ok: false, error: 'missing_conversation_id' }, 400);

    const supabase = sb();

    // 会話の所有者チェック
    const { data: conv, error: convErr } = await supabase
      .from('iros_conversations')
      .select('id,user_code,title')
      .eq('id', conversation_id)
      .maybeSingle();

    if (convErr) return json({ ok: false, error: 'conv_select_failed', detail: convErr.message }, 500);
    if (!conv) return json({ ok: false, error: 'conversation_not_found' }, 404);
    if (String(conv.user_code) !== String(userCode))
      return json({ ok: false, error: 'forbidden_owner_mismatch' }, 403);

    // 直近のメッセージを取得
    const { data: msgs, error: msgErr } = await supabase
      .from('iros_messages')
      .select('role,content,created_at')
      .eq('conversation_id', conversation_id)
      .in('role', ['user', 'assistant'])
      .order('created_at', { ascending: false })
      .limit(lookback);

    if (msgErr) {
      return json({ ok: false, error: 'messages_select_failed', detail: msgErr.message }, 500);
    }

    const history = (msgs ?? []).reverse();
    if (history.length === 0) {
      // メッセージが無ければ既存タイトル or 既定名で返す
      const fallback = (conv.title && conv.title.trim()) || '新規会話';
      return json({ ok: true, title: fallback });
    }

    // LLM プロンプト：短い日本語タイトル（8〜14字、記号なし、要素は“意図の核”）
    const system = [
      'あなたは「iros」。会話の“意図の核”を短い日本語タイトルに凝縮する。',
      '条件: 8〜14字、句読点・記号・英数字は使わない。装飾語や抽象語の連打は避け、具体的で静かな核を選ぶ。',
      '出力はタイトルのみ。説明や前後の語は付けない。',
    ].join('\n');

    const userMsg = [
      '以下の会話ログから、要の意図を表すタイトルをひとつだけ返してください。',
      ...history.map(m => `${m.role === 'user' ? 'ユーザー' : 'AI'}: ${String(m.content || '').replace(/\n+/g, ' ').slice(0, 600)}`),
    ].join('\n');

    const res = await fetch(CHAT_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        temperature: 0.3,
        max_tokens: 32,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: userMsg },
        ],
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      return json({ ok: false, error: 'openai_error', detail: errText || res.statusText }, 502);
    }

    let title = (await res.json())?.choices?.[0]?.message?.content?.toString()?.trim?.() || '';
    // 念のため整形（句読点・記号削除、長さ調整）
    title = title
      .replace(/[！!？?\[\]（）\(\)【】<>\-—_…・:：;；,，\.。]/g, '')
      .replace(/\s+/g, '')
      .slice(0, 14);
    if (title.length < 4) {
      // フォールバック
      title = (conv.title && conv.title.trim()) || '新規会話';
    }

    // 会話に保存（列が無い環境では無視）
    try {
      const nowIso = new Date().toISOString();
      await supabase
        .from('iros_conversations')
        .update({ title, updated_at: nowIso })
        .eq('id', conversation_id);
    } catch {
      /* noop */
    }

    return json({ ok: true, title }, 200);
  } catch (e: any) {
    return json({ ok: false, error: 'unhandled_error', detail: String(e?.message ?? e) }, 500);
  }
}
