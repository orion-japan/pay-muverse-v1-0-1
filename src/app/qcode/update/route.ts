// src/app/qcode/update/route.ts
import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

type Body = {
  user_id: string;
  new_q_code: string;
  intent?: string;
  emotion?: string;
  level?: string;
};

export async function PATCH(req: Request) {
  let body: Body;
  try { body = await req.json(); } catch { 
    return NextResponse.json({ ok:false, message:'invalid json' }, { status:400 });
  }
  const { user_id, new_q_code, intent, emotion, level } = body;
  if (!user_id || !new_q_code) {
    return NextResponse.json({ ok:false, message:'user_id & new_q_code required' }, { status:400 });
  }

  // ① ユニークチェック
  const { data: dup, error: dupErr } = await supabase
    .from('profiles')
    .select('user_id')
    .eq('q_code_current', new_q_code)
    .maybeSingle();
  if (dupErr) return NextResponse.json({ ok:false, message:dupErr.message }, { status:500 });
  if (dup && dup.user_id !== user_id) {
    return NextResponse.json({ ok:false, message:'q_code already taken' }, { status:409 });
  }

  // ② profiles 更新（recent_q_codes を先頭更新）
  const { data: prof, error: profErr } = await supabase
    .from('profiles')
    .select('recent_q_codes')
    .eq('user_id', user_id)
    .maybeSingle();
  if (profErr) return NextResponse.json({ ok:false, message:profErr.message }, { status:500 });

  const recent = Array.isArray(prof?.recent_q_codes) ? prof!.recent_q_codes : [];
  const nextRecent = [new_q_code, ...recent.filter((c: string) => c !== new_q_code)].slice(0, 3);

  const { error: upErr } = await supabase
    .from('profiles')
    .update({ q_code_current: new_q_code, recent_q_codes: nextRecent })
    .eq('user_id', user_id);
  if (upErr) return NextResponse.json({ ok:false, message:upErr.message }, { status:500 });

  // ③ conversation_variables 同期（なければ insert）
  const { data: cv, error: cvSelErr } = await supabase
    .from('conversation_variables')
    .select('user_id')
    .eq('user_id', user_id)
    .maybeSingle();
  if (cvSelErr) return NextResponse.json({ ok:false, message:cvSelErr.message }, { status:500 });

  if (cv) {
    const { error } = await supabase
      .from('conversation_variables')
      .update({ q_code: new_q_code, updated_at: new Date().toISOString() })
      .eq('user_id', user_id);
    if (error) return NextResponse.json({ ok:false, message:error.message }, { status:500 });
  } else {
    const { error } = await supabase
      .from('conversation_variables')
      .insert({ user_id, q_code: new_q_code });
    if (error) return NextResponse.json({ ok:false, message:error.message }, { status:500 });
  }

  // ④ 履歴ログに追記（任意の意図情報）
  const { error: logErr } = await supabase.from('q_code_logs').insert({
    user_id, q_code: new_q_code, intent, emotion, level
  });
  if (logErr) {
    // ログ失敗は致命ではないが通知
    console.warn('[q_code_logs] insert warning:', logErr.message);
  }

  return NextResponse.json({ ok:true, q_code:new_q_code, recent_q_codes: nextRecent });
}
