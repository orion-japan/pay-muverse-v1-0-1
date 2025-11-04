// src/app/api/notification-settings/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { verifyFirebaseAndAuthorize } from '@/lib/authz';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

// uid → user_code
async function uidToUserCode(uid: string) {
  const candidates: Array<{ table: string; codeCol: string; uidCol: string }> = [
    { table: 'users', codeCol: 'user_code', uidCol: 'firebase_uid' },
    { table: 'users', codeCol: 'user_code', uidCol: 'uid' },
    { table: 'profiles', codeCol: 'user_code', uidCol: 'uid' },
    { table: 'public_users', codeCol: 'user_code', uidCol: 'uid' },
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
    // 1. Firebase ID Token 検証
    const z = await verifyFirebaseAndAuthorize(req);
    if (!z.ok || !z.uid) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }

    // 2. uid → user_code
    const user_code = z.userCode ?? (await uidToUserCode(z.uid));

    // 3. consents 取得
    const { data, error } = await supabase
      .from('profiles')
      .select('consents')
      .eq('user_code', user_code)
      .maybeSingle();

    if (error) {
      // profiles が無い/権限エラー → 空を返す
      return NextResponse.json({}, { headers: { 'Cache-Control': 'no-store' } });
    }

    const consents = data?.consents && typeof data.consents === 'object' ? data.consents : {};

    return NextResponse.json(consents, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e: any) {
    console.error('[notification-settings] error:', e);
    return NextResponse.json(
      { error: e?.message ?? 'server error' },
      { status: 500, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
