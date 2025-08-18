// src/app/api/avatar/[userCode]/route.ts
import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

// Service Role を使うので Edge より Node.js 実行が安全
export const runtime = 'nodejs';

type RouteContext = { params: { userCode: string } };

export async function GET(req: Request, { params }: RouteContext) {
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

    // リクエスト元のオリジン（プレースホルダ用に使用）
    const { origin } = new URL(req.url);
    const fallback = `${origin}/avatar.png`;

    // profiles からアバターの保存パス（またはURL）を取得
    const { data: prof, error: profErr } = await admin
      .from('profiles')
      .select('avatar_url')
      .eq('user_code', userCode)
      .maybeSingle();

    if (profErr) {
      // 取得失敗 → プレースホルダにフォールバック
      return NextResponse.redirect(fallback, 302);
    }

    const avatar = prof?.avatar_url;
    if (!avatar) {
      // 未設定 → プレースホルダ
      return NextResponse.redirect(fallback, 302);
    }

    // もし avatar_url がフルURLならそのままリダイレクト
    if (/^https?:\/\//i.test(avatar)) {
      return NextResponse.redirect(avatar, 302);
    }

    // それ以外はストレージ内の相対パス想定（例: "avatars/669933/icon.png" など）
    // バケット名は 'avatars' を想定。必要なら環境変数化してください。
    const bucket = 'avatars';
    const filePath = avatar; // 例: "669933/icon.png" or "avatars/669933/icon.png" 等

    // avatar_url に先頭バケット名が含まれているかを緩く判定
    const path =
      filePath.startsWith(`${bucket}/`) ? filePath.replace(`${bucket}/`, '') : filePath;

    const { data: signed, error: signErr } = await admin.storage
      .from(bucket)
      .createSignedUrl(path, 60); // 署名URLは60秒有効

    if (signErr || !signed?.signedUrl) {
      return NextResponse.redirect(fallback, 302);
    }

    return NextResponse.redirect(signed.signedUrl, 302);
  } catch (e) {
    // 予期せぬ例外 → プレースホルダにフォールバック
    try {
      const { origin } = new URL(req.url);
      return NextResponse.redirect(`${origin}/avatar.png`, 302);
    } catch {
      return NextResponse.json({ error: 'unexpected error' }, { status: 500 });
    }
  }
}
