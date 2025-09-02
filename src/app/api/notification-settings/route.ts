import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// uid -> user_code（強化版）
// - まず users(firebase_uid) を見る
// - 見つからなければ users(uid) → profiles(uid) → public_users(uid) を順にフォールバック
async function uidToUserCode(uid: string) {
  // ヒント（任意）：ヘッダで直接 user_code を渡されたら最優先で使う
  // （テストや一時運用で便利。不要ならこの2行を削除してOK）
  // const hinted = headers().get('x-user-code'); if (hinted) return hinted;

  const candidates: Array<{ table: string; codeCol: string; uidCol: string }> = [
    { table: 'users',         codeCol: 'user_code', uidCol: 'firebase_uid' },
    { table: 'users',         codeCol: 'user_code', uidCol: 'uid' },
    { table: 'profiles',      codeCol: 'user_code', uidCol: 'uid' },
    { table: 'public_users',  codeCol: 'user_code', uidCol: 'uid' },
  ];

  for (const c of candidates) {
    const { data, error } = await supabase
      .from(c.table)
      .select(c.codeCol)
      .eq(c.uidCol, uid)
      .maybeSingle();

    if (!error && data?.[c.codeCol]) {
      return String(data[c.codeCol]);
    }
  }
  throw new Error('user_code not found');
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const uid = searchParams.get('uid');
    if (!uid) {
      return NextResponse.json({ error: 'uid required' }, { status: 400 });
    }

    const user_code = await uidToUserCode(uid);

    const { data, error } = await supabase
      .from('profiles')
      .select('consents')
      .eq('user_code', user_code)
      .maybeSingle();

    if (error) {
      // profiles が無い/権限が無い場合は空を返す（500にしない）
      return NextResponse.json({}, { headers: { 'Cache-Control': 'no-store' } });
    }

    // consents が null/未設定でも空オブジェクトを返す
    const consents = (data?.consents && typeof data.consents === 'object') ? data.consents : {};
    return NextResponse.json(consents, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message ?? 'server error' },
      { status: 500, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
