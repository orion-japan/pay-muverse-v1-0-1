import { NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabaseServer';
import fetch from 'node-fetch';

export async function POST(req: Request) {
  console.log('========== [API] copyImageToPublic START ==========');
  try {
    const { originalUrl, userCode } = await req.json();
    console.log('[API] 📥 入力値', { originalUrl, userCode });

    if (!originalUrl || !userCode) {
      return NextResponse.json({ error: 'Missing parameters' }, { status: 400 });
    }

    const fileName = originalUrl.split('/').pop();
    if (!fileName) {
      return NextResponse.json({ error: 'Invalid file name' }, { status: 400 });
    }

    // 画像データ取得
    const response = await fetch(originalUrl);
    if (!response.ok) {
      console.error('[API] ❌ fetch失敗', response.status, response.statusText);
      return NextResponse.json({ error: 'Failed to fetch original image' }, { status: 500 });
    }
    const arrayBuffer = await response.arrayBuffer();

    // Supabase public-board にアップロード
    const { error: uploadError } = await supabaseServer.storage
      .from('public-board')
      .upload(`${userCode}/${fileName}`, Buffer.from(arrayBuffer), {
        upsert: true,
        contentType: response.headers.get('content-type') || 'image/png',
      });

    if (uploadError) {
      console.error('[API] ❌ アップロード失敗', uploadError);
      return NextResponse.json({ error: uploadError.message }, { status: 500 });
    }

    const publicUrl = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/public-board/${userCode}/${fileName}`;
    console.log('[API] ✅ アップロード完了 →', publicUrl);

    return NextResponse.json({ url: publicUrl }, { status: 200 });
  } catch (err) {
    console.error('[API] ❌ 処理中にエラー', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
