import { NextResponse } from 'next/server';
import { supabaseAdmin as supabaseServer } from '@/lib/supabaseAdmin';

export async function POST(req: Request) {
  console.log('========== [post-image] アップロード開始 ==========');

  const formData = await req.formData();
  const userCode = formData.get('userCode') as string;
  const files = formData.getAll('file') as File[];

  if (!userCode || files.length === 0) {
    console.error('[post-image] ❌ 必要なデータが不足しています');
    return NextResponse.json({ error: 'userCode または file が不足しています' }, { status: 400 });
  }

  const uploadedUrls: string[] = [];

  for (const file of files) {
    const timestamp = Date.now();
    const fileExt = file.name.split('.').pop() || 'png';

    // ★ ファイル名を安全に変換（英数字・記号以外を削除）
    const safeName = file.name
      .replace(/\s+/g, '_') // 空白をアンダースコアに
      .replace(/[^a-zA-Z0-9_.-]/g, ''); // 記号や日本語を除去

    const filePath = `${userCode}/${timestamp}_${safeName}`;

    const { error: uploadError } = await supabaseServer.storage
      .from('private-posts')
      .upload(filePath, file, {
        cacheControl: '3600',
        upsert: true,
        contentType: file.type || `image/${fileExt}`,
      });

    if (uploadError) {
      console.error('[post-image] ❌ アップロード失敗', filePath, uploadError);
      return NextResponse.json(
        { error: 'アップロード失敗', detail: uploadError.message },
        { status: 500 },
      );
    }

    // ✅ public URL を取得して返す（構造は同じ `urls: []` で）
    const { data: publicUrlData } = supabaseServer.storage
      .from('private-posts')
      .getPublicUrl(filePath);

    if (!publicUrlData?.publicUrl) {
      console.error('[post-image] ❌ publicUrl取得失敗', filePath);
      return NextResponse.json({ error: 'publicUrl取得失敗' }, { status: 500 });
    }

    uploadedUrls.push(publicUrlData.publicUrl);
    console.log('[post-image] ✅ アップロード成功:', filePath);
    console.log('[post-image] 🌐 公開URL:', publicUrlData.publicUrl);
  }

  return NextResponse.json({ urls: uploadedUrls }, { status: 200 });
}
