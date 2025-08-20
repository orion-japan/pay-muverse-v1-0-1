import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

// Supabase クライアント
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// GET /pay/qcode/[user_code]/get
export async function GET(
  req: NextRequest,
  { params }: { params: { user_code: string } }
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
    // users テーブルから q_code を取得する例
    const { data, error } = await supabase
      .from('users')
      .select('q_code')
      .eq('user_code', user_code)
      .maybeSingle();

    if (error) {
      console.error('[qcode/get] ❌ supabase error', error.message);
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

    return NextResponse.json({ ok: true, q_code: data.q_code });
  } catch (e: any) {
    console.error('[qcode/get] ❌ unexpected', e);
    return NextResponse.json(
      { ok: false, message: 'unexpected error' },
      { status: 500 }
    );
  }
}
