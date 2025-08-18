import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export async function GET(
  _req: NextRequest,
  { params }: { params: { userCode: string } }
) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  const userCode = params.userCode;
  if (!userCode) return NextResponse.json({ error: 'userCode required' }, { status: 400 });

  // profiles からパス取得
  const { data: prof, error } = await admin
    .from('profiles')
    .select('avatar_url')
    .eq('user_code', userCode)
    .maybeSingle();

  if (error || !prof?.avatar_url) {
    // プレースホルダなどにフォールバックしてもOK
    return NextResponse.redirect(new URL('/avatar.png', process.env.NEXT_PUBLIC_BASE_URL), 302);
  }

  // ストレージに保存しているフルパス（例: avatars/{userCode}/xxx.png）
  const filePath = prof.avatar_url;

  const { data: signed, error: signErr } = await admin.storage
    .from('avatars') // バケット名
    .createSignedUrl(filePath, 60); // 60秒有効

  if (signErr || !signed?.signedUrl) {
    return NextResponse.redirect(new URL('/avatar.png', process.env.NEXT_PUBLIC_BASE_URL), 302);
  }

  return NextResponse.redirect(signed.signedUrl, 302);
}
