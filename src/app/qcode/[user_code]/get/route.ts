// src/app/qcode/[user_code]/get/route.ts
import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

// Node 実行を明示（Service Role を使う想定のため Edge だと不可）
export const runtime = 'nodejs';
// キャッシュせず都度取得したい場合
export const dynamic = 'force-dynamic';

// Supabase（サーバー権限で読む想定）
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// GET /qcode/[user_code]/get
export async function GET(
  _req: Request,
  // ★ ここがポイント：Record<string, string | string[]> にする
  { params }: { params: Record<string, string | string[]> }
) {
  const raw = params?.user_code;
  const user_code = Array.isArray(raw) ? raw[0] : raw;

  if (!user_code) {
    return NextResponse.json(
      { ok: false, message: 'user_code is required' },
      { status: 400 }
    );
  }

  console.log('[qcode/get] ▶ user_code:', user_code);

  try {
    // スキーマに合わせてテーブル名を調整してください
    const { data, error } = await supabase
      .from('users')              // 例: users テーブルに q_code がある場合
      .select('q_code')
      .eq('user_code', user_code)
      .maybeSingle();

    if (error) {
      console.error('[qcode/get] ❌ supabase error', error);
      return NextResponse.json(
        { ok: false, message: error.message },
        { status: 500 }
      );
    }

    if (!data) {
      return NextResponse.json(
        { ok: false, message: 'not found' },
        { status: 404 }
      );
    }

    return NextResponse.json({ ok: true, q_code: data.q_code ?? null });
  } catch (e: any) {
    console.error('[qcode/get] ❌ unexpected', e);
    return NextResponse.json(
      { ok: false, message: 'unexpected error' },
      { status: 500 }
    );
  }
}
