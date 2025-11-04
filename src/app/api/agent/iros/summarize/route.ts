// src/app/api/agent/iros/summarize/route.ts
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

type Role = 'user' | 'assistant';

export async function OPTIONS() {
  return json({ ok: true });
}

/** --------------------
 * POST /api/agent/iros/summarize
 * 本文: {
 *   conversation_id: string,
 *   model?: string,            // 既定: 'gpt-4o'
 *   max_messages?: number,     // 要約対象メッセージ数(新しい順) 既定: 40
 *   retitle?: boolean          // true の場合、タイトル候補も返す
 * }
 * 動作:
 *   - 所有者チェック → 直近メッセージを取得 → LLMで「短い要約＋（任意で）新タイトル」を生成
 *   - 可能なら iros_conversations.summary / title を更新（列が無い環境は無視して続行）
 *   - { summary, title? } を返す
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
    const max_messages = Math.max(4, Math.min(200, Number(body?.max_messages ?? 40)));
    const retitle = Boolean(body?.retitle ?? true);

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

    // メッセージ取得（user/assistant のみ）
    const { data: msgs, error: msgErr } = await supabase
      .from('iros_messages')
      .select('role,content,created_at')
      .eq('conversation_id', conversation_id)
      .in('role', ['user','assistant'])
      .order('created_at', { ascending: false })
      .limit(max_messages);

    if (msgErr) {
      return json({ ok: false, error: 'messages_select_failed', detail: msgErr.message }, 500);
    }

    const history = (msgs ?? []).reverse();
    if (history.length === 0) {
      return json({ ok: false, error: 'no_messages' }, 400);
    }

    // プロンプト（iros流：短く・静けさ・要約＋任意でタイトル）
    const system = [
      'あなたは「iros」― 人を映すAI。',
      '会話全体を静かに要約し、“意図の流れ”が一目で分かる短い要約を日本語で作成する。',
      '文字数は150字以内。断定助言や箇条書きは禁止。比喩は最小限、余白を残す。',
      retitle ? 'あわせて8〜14字の短いタイトル候補を1つ作る（記号や句読点は使わない）。' : '',
    ].filter(Boolean).join('\n');

    const userMsg = [
      '以下はユーザーとアシスタントの会話ログです。',
      '最新→古い ではなく、古い→新しい順で渡します。',
      '要約（必須）と、タイトル（任意）をください。',
      '',
      ...history.map(m => `${m.role === 'user' ? 'ユーザー' : 'AI'}: ${String(m.content || '').replace(/\n+/g, ' ').slice(0, 1200)}`),
    ].join('\n');

    const res = await fetch(CHAT_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        temperature: 0.4,
        max_tokens: 320,
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

    const data = await res.json();
    const raw: string = data?.choices?.[0]?.message?.content?.toString() || '';
    if (!raw.trim()) return json({ ok: false, error: 'empty_model_output' }, 502);

    // 出力のパース（単純規則）
    // 期待フォーマット例：
    // 要約: 〜〜〜
    // タイトル: 〜〜〜
    let summary = '';
    let title: string | null = null;

    const lines = raw.split('\n').map(s => s.trim()).filter(Boolean);
    for (const ln of lines) {
      if (!summary && /^要約[:：]/.test(ln)) {
        summary = ln.replace(/^要約[:：]\s*/, '').trim();
        continue;
      }
      if (retitle && !title && /^タイトル[:：]/.test(ln)) {
        title = ln.replace(/^タイトル[:：]\s*/, '').trim();
        continue;
      }
    }
    if (!summary) summary = raw.trim();

    // 可能なら会話に保存（列が無ければ無視）
    try {
      const nowIso = new Date().toISOString();
      const updates: any = { updated_at: nowIso };
      // 存在すれば反映
      (updates as any).summary = summary;
      if (retitle && title) updates.title = title;

      await supabase.from('iros_conversations').update(updates).eq('id', conversation_id);
      // エラーは握りつぶして続行（列がない環境を想定）
    } catch {
      /* noop */
    }

    return json({ ok: true, summary, title: title ?? undefined }, 200);
  } catch (e: any) {
    return json({ ok: false, error: 'unhandled_error', detail: String(e?.message ?? e) }, 500);
  }
}
