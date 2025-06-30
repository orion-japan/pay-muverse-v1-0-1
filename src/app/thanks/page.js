// src/app/thanks/page.tsx
export default function ThanksPage() {
  return (
    <main className="min-h-screen flex flex-col items-center justify-center p-8">
      <h1 className="text-2xl mb-4">登録が完了しました！</h1>
      <p>以下よりアプリにお入りください</p>
      <a href="https://muverse.jp/" className="text-blue-600 underline mt-2">https://muverse.jp/</a>
    </main>
  );
}

// src/app/api/register/route.ts
import { NextRequest, NextResponse } from 'next/server';

export async function POST(req) {
  try {
    const { nickname, email, password, phone_number, ref, usertype } = await req.json();
    const ip = req.headers.get('x-forwarded-for') || req.ip || '';
    const register_date = new Date().toISOString();

    console.log('管理ログ:', { nickname, email, phone_number, ref, ip, register_date, usertype });

    // TODO: Supabase Auth 登録処理
    // TODO: Supabase DB へINSERT
    // TODO: Click API 連携

    return NextResponse.json({ success: true });
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
