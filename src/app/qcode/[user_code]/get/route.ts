// src/app/qcode/[user_code]/get/route.ts
import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

// （必要なら）Node実行に固定したい場合だけ有効化
// export const runtime = 'nodejs';

// Supabase（サーバー権限で読む想定）
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// GET /qcode/[user_code]/get
export async function GET(
  _req: Request,
  { params }: { params: { user_code: string } } // ★ ここが重要（context で受ける）
) {
  const { user_code } = params;

  if (!user_code) {
    return NextResponse.json(
      { ok: false, message: 'user_code is required' },
      { status: 400 }
    );
  }

  console.log('[qcode/get] ▶ user_code:', user_code);

  try {
    // 取得元のテーブルは実際のスキーマに合わせて調整してください
    // 例1: users テーブルに q_code がある場合
    const { data, error } = await supabase
      .from('users')
      .select('q_code')
      .eq('user_code', user_code)
      .maybeSingle();

    // 例2（profiles にある場合）:
    // const { data, error } = await supabase
    //   .from('profiles')
    //   .select('q_code')
    //   .eq('user_code', user_code)
    //   .maybeSingle();

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
