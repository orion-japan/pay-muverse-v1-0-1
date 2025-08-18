// src/app/api/avatar/[userCode]/route.ts
import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

// Service Role を使うので Node.js ランタイム推奨
export const runtime = 'nodejs';

export async function GET(
  req: Request,
  { params }: { params: { userCode: string } } // ← 型は“ここで”リテラルで書く
) {
  try {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
    if (!url || !serviceKey) {
      return NextResponse.json(
        { error: 'Supabase credentials are not set' },
        { status: 500 }
      );
    }

    const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

    const userCode = params?.userCode;
    if (!userCode) {
      return NextResponse.json({ error: 'userCode required' }, { status: 400 });
    }

    // フォールバック画像のオリジンを決定
    const { origin } = new URL(req.url);
    const fallback = `${origin}/avatar.png`;

    // profiles からアバターの保存パス（またはURL）を取得
    const { data: prof, error: profErr } = await admin
      .from('profiles')
      .select('avatar_url')
      .eq('user_code', userCode)
      .maybeSingle();

    if (profErr) return NextResponse.redirect(fallback, 302);

    const avatar = prof?.avatar_url;
    if (!avatar) return NextResponse.redirect(fallback, 302);

    // すでに完全URLならそのまま
    if (/^https?:\/\//i.test(avatar)) {
      return NextResponse.redirect(avatar, 302);
    }

    // ストレージ内の相対パス想定
    const bucket = 'avatars';
    const path = avatar.startsWith(`${bucket}/`) ? avatar.slice(bucket.length + 1) : avatar;

    const { data: signed, error: signErr } = await admin.storage
      .from(bucket)
      .createSignedUrl(path, 60);

    if (signErr || !signed?.signedUrl) {
      return NextResponse.redirect(fallback, 302);
    }

    return NextResponse.redirect(signed.signedUrl, 302);
  } catch {
    const { origin } = new URL(req.url);
    return NextResponse.redirect(`${origin}/avatar.png`, 302);
  }
}
