import { NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabaseServer';

export async function POST(req: Request) {
  console.log('========== [post-image] アップロード開始 ==========');

  const formData = await req.formData();
  const userCode = formData.get('userCode') as string;
  const files = formData.getAll('file') as File[];

  if (!userCode || files.length === 0) {
    console.error('[post-image] ❌ 必要なデータが不足しています');
    return NextResponse.json(
      { error: 'userCode または file が不足しています' },
      { status: 400 }
    );
  }

  const uploadedPaths: string[] = [];

  for (const file of files) {
    const timestamp = Date.now();
    const fileExt = file.name.split('.').pop() || 'png';

    // ★ ファイル名を安全に変換（英数字・記号以外を削除）
    const safeName = file.name
      .replace(/\s+/g, '_')            // 空白をアンダースコアに
      .replace(/[^a-zA-Z0-9_.-]/g, '') // 記号や日本語を除去

    const filePath = `${userCode}/${timestamp}_${safeName}`;

    const { error } = await supabaseServer.storage
      .from('private-posts')
      .upload(filePath, file, {
        cacheControl: '3600',
        upsert: true,
        contentType: file.type || `image/${fileExt}`,
      });

    if (error) {
      console.error('[post-image] ❌ アップロード失敗', filePath, error);
      return NextResponse.json(
        { error: 'アップロード失敗', detail: error.message },
        { status: 500 }
      );
    }

    uploadedPaths.push(filePath);
    console.log('[post-image] ✅ アップロード成功:', filePath);
  }

  return NextResponse.json({ urls: uploadedPaths }, { status: 200 });
}
