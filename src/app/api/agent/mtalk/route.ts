// src/app/api/mtalk/mirra/route.ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SERVICE_ROLE, verifyFirebaseAndAuthorize } from '@/lib/authz';
import { buildSystemPrompt as buildMirraSystemPrompt } from '@/lib/mirra/buildSystemPrompt';
import { randomUUID } from 'crypto';

function sb() {
  return createClient(SUPABASE_URL!, SERVICE_ROLE!, { auth: { persistSession: false } });
}

export async function POST(req: NextRequest) {
  const z = await verifyFirebaseAndAuthorize(req as any);
  if (!z.ok) return NextResponse.json({ error: z.error }, { status: z.status });
  if (!z.allowed) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  const raw = await req.text();
  const body = raw ? JSON.parse(raw) : {};
  const text: string = (body.text ?? body.message ?? '').trim();
  const user_code: string = body.user_code ?? z.userCode;
  const thread_id: string = String(body.thread_id ?? body.conversation_id ?? `mirra-${user_code}`);

  if (!text) return NextResponse.json({ ok:false, error:'empty' }, { status: 400 });

  const s = sb();

  // --- スレッドの新規判定用フラグ ---
  let isNewThread = false;

  // 1) スレッド upsert
  {
    // 既存チェック
    const { data: existing, error: chkErr } = await s.from('talk_threads')
      .select('id')
      .eq('id', thread_id)
      .maybeSingle();
    if (!chkErr && !existing) {
      isNewThread = true;
    }

    const { error } = await s.from('talk_threads').upsert({
      id: thread_id,
      user_a_code: user_code,
      agent: 'mirra',
      created_by: user_code,
      title: 'mirra 会話',
      updated_at: new Date().toISOString(),
    }, { onConflict: 'id' });
    if (error) {
      console.error('[mirra] upsert thread error:', error);
      return NextResponse.json({ ok:false, error:error.message }, { status: 500 });
    }
  }

  // 2) ユーザー発話 保存
  const now = new Date().toISOString();
  {
    const { error } = await s.from('talk_messages').insert([{
      thread_id,
      sender_code: user_code,
      user_code,
      role: 'user',
      content: text,
      created_at: now,
    }]);
    if (error) {
      console.error('[mirra] insert user msg error:', error);
      return NextResponse.json({ ok:false, error:error.message }, { status: 500 });
    }
  }

  // 2.5) 履歴収集（system含む）
  const { data: history, error: hErr } = await s
    .from('talk_messages')
    .select('role, content, created_at')
    .eq('thread_id', thread_id)
    .order('created_at', { ascending: true })
    .limit(40);
  if (hErr) console.error('[mirra] history error:', hErr);

  const sys = (typeof buildMirraSystemPrompt === 'function')
    ? buildMirraSystemPrompt()
    : 'You are Mirra, a gentle “mind-talk” assistant. Reply in Japanese with 3 bullets: (1) message, (2) body anchor, (3) next small action.';

  const messagesForLLM: Array<{role:'system'|'user'|'assistant', content:string}> = [
    { role: 'system', content: sys },
    ...(history?.map(m => ({ role: m.role as any, content: m.content })) ?? []),
  ];

  // 3) LLM 呼び出し（本番 / フェールセーフ）
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
    const json = await resp.json();
    reply = json.choices?.[0]?.message?.content?.trim() || '';
  } catch (e:any) {
    console.warn('[mirra] LLM fallback:', e?.message);
    reply = [
      `1. メッセージ: 受け取りました。「${text.slice(0, 60)}」について一緒に整えます。`,
      '2. 体のアンカー: 深呼吸を3回。吐く息を長めにして肩の力を抜きます。',
      '3. 次の一歩: いま一番気になる1点を短く送ってください。'
    ].join('\n');
    meta = { provider:'local-fallback' };
  }

  // 4) アシスタント発話 保存
  {
    const { error } = await s.from('talk_messages').insert([{
      thread_id,
      sender_code: 'mirra',
      role: 'assistant',
      content: reply,
      meta,
      created_at: new Date().toISOString(),
    }]);
    if (error) console.error('[mirra] insert bot msg error:', error);
  }

  // 5) スレッドの最終更新
  await s.from('talk_threads')
    .update({ last_message_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', thread_id);

  // 6) クレジット消費（初回=2、続き=1）
  try {
    const amount = isNewThread ? 2 : 1;
    const idemKey = `mirra:${thread_id}:${randomUUID()}`;
    const { error: cErr } = await s.rpc('credit_capture', {
      p_user_code: user_code,
      p_amount: amount,
      p_reason: 'mirra_chat_turn',
      p_source_kind: 'agent',
      p_source_id: 'mirra',
      p_action: 'chat_turn',
      p_idempotency_key: idemKey,
    });
    if (cErr) console.error('[mirra] credit_capture error', cErr);
  } catch (e) {
    console.error('[mirra] credit rpc failed', e);
  }

  return NextResponse.json({ ok: true, thread_id, reply, meta });
}
