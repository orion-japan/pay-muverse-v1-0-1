// Next.js Route Handler（例）
// file（従来のアップロード）or storage_path（直PUT後の保存）のどちらか必須に
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

export async function POST(req: Request) {
  try {
    const form = await req.formData();

    const user_code = String(form.get('user_code') ?? '');
    const conversation_code = (form.get('conversation_code') ?? '') as string;
    const index = Number(form.get('index') ?? 0);
    const ocr_text = (form.get('ocr_text') ?? '') as string;

    const file = form.get('file') as File | null; // 旧フロー
    const storage_path = (form.get('storage_path') ?? '') as string; // 新フロー（直PUT）

    if (!user_code) {
      return NextResponse.json({ ok: false, error: 'user_code required' }, { status: 400 });
    }
    if (!file && !storage_path) {
      // ★ ここを変更：file または storage_path のどちらかでOK
      return NextResponse.json({ ok: false, error: 'file or storage_path required' }, { status: 400 });
    }

    // ---- ここから先はあなたの保存ロジックに合わせて ----
    // 例）Supabase の DB にメタを記録するだけ（擬似実装）
    // - file がある場合は必要に応じて別ストレージへ保存
    // - storage_path の場合は、すでに Supabase Storage にある前提でパスだけ保存
    //
    // const supabase = createClient(... SERVICE_ROLE ...);
    // let stored_path = storage_path;
    // if (file) {
    //   // 旧フローの互換: アップロードして stored_path を得る
    //   const uploadRes = await supabase.storage.from('uploads')
    //     .upload(`mui/legacy/${Date.now()}-${file.name}`, file, { upsert: false });
    //   if (uploadRes.error) throw uploadRes.error;
    //   stored_path = uploadRes.data.path;
    // }
    // await supabase.from('fshot').insert({
    //   user_code, conversation_code, index, ocr_text, storage_path: stored_path
    // });

    // まずは成功だけ返す（最小）
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? 'server error' }, { status: 500 });
  }
}
