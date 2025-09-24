export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SERVICE_ROLE, verifyFirebaseAndAuthorize } from '@/lib/authz';
import { buildSystemPrompt as buildMirraSystemPrompt } from '@/lib/mirra/buildSystemPrompt';

function json(data: any, init?: number | ResponseInit) {
  const status = typeof init === 'number' ? init : (init as ResponseInit | undefined)?.['status'] ?? 200;
  const headers = new Headers(typeof init === 'number' ? undefined : (init as ResponseInit | undefined)?.headers);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  return new NextResponse(JSON.stringify(data), { status, headers });
}

export async function POST(req: NextRequest) {
  try {
    // 認証
    const z = await verifyFirebaseAndAuthorize(req as any);
    if (!z?.ok) return json({ ok:false, error:z?.error || 'unauthorized' }, z?.status || 401);
    if (!z.allowed) return json({ ok:false, error:'forbidden' }, 403);

    // 入力
    const body = await req.json().catch(() => ({}));
    const text: string = String(body.text ?? body.message ?? '').trim();
    if (!text) return json({ ok:false, error:'empty' }, 400);

    const user_code: string = body.user_code ?? z.userCode;
    const conversation_id: string = String(body.thread_id ?? body.conversation_id ?? `mirra-${user_code}`);

    const s = createClient(SUPABASE_URL!, SERVICE_ROLE!, { auth: { persistSession: false } });

    // スレッド upsert（タイトルは1回で十分）
    {
      const { error } = await s.from('talk_threads').upsert({
        id: conversation_id,
        user_a_code: user_code,
        agent: 'mirra',
        created_by: user_code,
        title: 'mirra 会話',
        updated_at: new Date().toISOString(),
      }, { onConflict: 'id' });
      if (error) {
        console.error('[mtalk] upsert thread error:', error);
        return json({ ok:false, error:error.message }, 500);
      }
    }

    const now = new Date().toISOString();

    // ユーザー発話 保存
    {
      const { error } = await s.from('talk_messages').insert([{
        thread_id: conversation_id,    // ★ ここが読み出し側と一致する鍵
        sender_code: user_code,
        user_code,
        role: 'user',
        content: text,
        created_at: now,
      }]);
      if (error) {
        console.error('[mtalk] insert user msg error:', error);
        return json({ ok:false, error:error.message }, 500);
      }
    }

    // 履歴（system込みで40件）
    const sys = (typeof buildMirraSystemPrompt === 'function')
      ? buildMirraSystemPrompt()
      : 'You are Mirra, a gentle “mind-talk” assistant. Reply in Japanese with 3 bullets: (1) message, (2) body anchor, (3) next small action.';

    const { data: hist, error: hErr } = await s
      .from('talk_messages')
      .select('role, content, created_at')
      .eq('thread_id', conversation_id)
      .order('created_at', { ascending: true })
      .limit(40);
    if (hErr) console.warn('[mtalk] history warn:', hErr?.message);

    const messagesForLLM: Array<{role:'system'|'user'|'assistant', content:string}> = [
      { role: 'system', content: sys },
      ...(hist ?? []).map(m => ({ role: m.role as any, content: String(m.content ?? '') })),
    ];

    // LLM 呼び出し
    let reply = '';
    let meta: any = { provider:'openai', model:'gpt-4o-mini' };
    try {
      const key = process.env.OPENAI_API_KEY;
      if (!key) throw new Error('OPENAI_API_KEY missing');

      const resp = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
        body: JSON.stringify({ model: 'gpt-4o-mini', messages: messagesForLLM, temperature: 0.7 }),
      });
      if (!resp.ok) throw new Error(`openai ${resp.status}`);
      const js = await resp.json();
      reply = js?.choices?.[0]?.message?.content?.trim() || '';
    } catch (e:any) {
      console.warn('[mtalk] LLM fallback:', e?.message);
      reply = [
        `1. メッセージ: 受け取りました。「${text.slice(0, 60)}」について一緒に整えます。`,
        '2. 体のアンカー: 深呼吸を3回。吐く息を長めにして肩の力を抜きます。',
        '3. 次の一歩: いま一番気になる1点を短く送ってください。',
      ].join('\n');
      meta = { provider:'local-fallback' };
    }

    // アシスタント発話 保存
    {
      const { error } = await s.from('talk_messages').insert([{
        thread_id: conversation_id,
        sender_code: 'mirra',
        role: 'assistant',
        content: reply,
        meta,
        created_at: new Date().toISOString(),
      }]);
      if (error) console.error('[mtalk] insert assistant msg error:', error);
    }

    // スレッド最終更新
    await s.from('talk_threads')
      .update({ last_message_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', conversation_id);

    // クレジット 1 消費（fn_charge_credits が無ければスキップ）
    let balance_after: number | null = null;
    try {
      const { data: rpc, error: rpcErr } = await s.rpc('fn_charge_credits', {
        p_user_code: user_code,
        p_cost: 1,
        p_reason: 'mirra_chat_turn',
        p_meta: { agent: 'mirra', conversation_id },
        p_ref_conversation_id: conversation_id,
        p_ref_sub_id: null,
      });
      if (rpcErr) {
        // 旧ファンクション名にフォールバック（存在すれば）
        const { error: altErr } = await s.rpc('credit_capture', {
          p_user_code: user_code,
          p_amount: 1,
          p_reason: 'mirra_chat_turn',
          p_source_kind: 'agent',
          p_source_id: 'mirra',
          p_action: 'chat_turn',
          p_idempotency_key: `mirra:${conversation_id}:${Date.now()}`,
        });
        if (altErr) console.warn('[mtalk] credit rpc warn:', altErr.message);
      }
      // 残高取得
      const { data: u, error: uErr } = await s.from('users').select('sofia_credit').eq('user_code', user_code).maybeSingle();
      if (!uErr && u && typeof u.sofia_credit === 'number') balance_after = Number(u.sofia_credit);
    } catch (e) {
      console.warn('[mtalk] credit charge skipped:', (e as any)?.message || e);
    }

    return json({
      ok: true,
      route: 'api/agent/mtalk',
      agent: 'mirra',
      conversation_id,
      thread_id: conversation_id,
      reply,
      meta,
      credit_balance: balance_after,
      used_fallback: meta?.provider === 'local-fallback',
    });
  } catch (e:any) {
    console.error('[mtalk] error', e);
    return json({ ok:false, error:'internal_error', detail:String(e?.message || e) }, 500);
  }
}
