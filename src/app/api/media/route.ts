// src/app/api/media/route.ts
import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY! // ← サーバー側だけ
);

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const path = searchParams.get('path');
    if (!path) {
      return NextResponse.json({ error: 'path required' }, { status: 400 });
    }

    // 署名付きURLを生成
    const { data, error } = await supabase.storage
      .from('private-posts') // ← bucket名を指定
      .createSignedUrl(path, 60 * 60); // 1時間有効

    if (error) {
      console.error('[media] signedUrl error', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ signedUrl: data.signedUrl });
  } catch (e: any) {
    console.error('[media] fatal error', e);
    return NextResponse.json({ error: 'internal server error' }, { status: 500 });
  }
}
