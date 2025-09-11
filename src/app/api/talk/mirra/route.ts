// src/app/api/talk/mirra/route.ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SERVICE_ROLE, verifyFirebaseAndAuthorize } from '@/lib/authz';
import { buildMirraSystemPrompt } from '@/lib/mirra/prompt'; // あれば

function sb() {
  return createClient(SUPABASE_URL!, SERVICE_ROLE!, { auth: { persistSession: false } });
}

export async function POST(req: NextRequest) {
  const z = await verifyFirebaseAndAuthorize(req as any);
  if (!z.ok) return NextResponse.json({ error: z.error }, { status: z.status });
  if (!z.allowed) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  const raw = await req.text();
  const body = raw ? JSON.parse(raw) : {};
  const text: string = (body.text ?? '').trim();
  const user_code: string = body.user_code ?? z.userCode;
  const thread_id: string = String(body.thread_id ?? `mirra-${user_code}`);

  if (!text) return NextResponse.json({ ok:false, error:'empty' }, { status: 400 });

  const s = sb();

  // 1) スレッド確保（存在しなければ作る）
  {
    const { error } = await s.from('talk_threads')
      .upsert({
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

  // 2) ユーザ発話 保存
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

  // 3) LLM 呼び出し（ダミー/本番切替）
  let reply = '';
  try {
    // 実際は OpenAI 等に投げる。ここは簡略。
    // const prompt = buildMirraSystemPrompt();
    // reply = await callLLM(prompt, history...);
    reply = [
      '1. メッセージ: あなたの思いを大切にしています。',
      '2. 体のアンカー: 深呼吸して肩の力を抜きましょう。',
      '3. 台本の仮説…',
    ].join('\n');
  } catch (e:any) {
    reply = '（ただいま応答が混み合っています。もう一度お試しください）';
  }

  // 4) アシスタント発話 保存
  const meta = { provider:'openai', model:'gpt-4o-mini' };
  {
    const { error } = await s.from('talk_messages').insert([{
      thread_id,
      sender_code: 'mirra',
      role: 'assistant',
      content: reply,
      meta,
      created_at: new Date().toISOString(),
    }]);
    if (error) {
      console.error('[mirra] insert bot msg error:', error);
      // 返信保存に失敗してもユーザー側に簡易応答は返す
    }
  }

  // 5) スレッドの最終更新を反映（並び順安定の肝）
  await s.from('talk_threads')
    .update({ last_message_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', thread_id);

  return NextResponse.json({
    ok: true,
    thread_id,
    reply,
    meta,
  });
}
