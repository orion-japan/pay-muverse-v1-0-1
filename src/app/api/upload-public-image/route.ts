// src/app/api/upload-public-image/route.ts
import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY! // service_roleキー
);

export async function POST(req: Request) {
  try {
    const { fileName, fileData, userCode, contentType } = await req.json();

    if (!fileName || !fileData || !userCode) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    const filePath = `${userCode}/${fileName}`;

    const { error: uploadError } = await supabaseAdmin.storage
      .from('public-posts')
      .upload(filePath, Buffer.from(fileData, 'base64'), {
        upsert: true,
        contentType: contentType || 'image/png',
      });

    if (uploadError) {
      console.error('[❌ アップロード失敗]', uploadError);
      return NextResponse.json({ error: uploadError.message }, { status: 400 });
    }

    const { data } = supabaseAdmin.storage
      .from('public-posts')
      .getPublicUrl(filePath);

    console.log('[✅ 公開URL取得成功]', data.publicUrl);
    return NextResponse.json({ publicUrl: data.publicUrl });
  } catch (err) {
    console.error('[❌ サーバーエラー]', err);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
