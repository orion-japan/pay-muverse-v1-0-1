// src/app/api/upload-avatar/route.ts
export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { adminAuth } from '@/lib/firebase-admin';
// @ts-ignore
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const file = form.get('file') as File | null;
    let idToken = (form.get('idToken') as string | null) || null;
    let uid = (form.get('uid') as string | null) || null;

    if (!file) {
      return NextResponse.json({ success: false, error: 'Missing file' }, { status: 400 });
    }

    // idToken が来ていれば Admin で検証して uid を確定
    if (idToken) {
      const decoded = await adminAuth.verifyIdToken(idToken, true);
      uid = decoded.uid;
    }

    if (!uid) {
      return NextResponse.json({ success: false, error: 'Missing uid (no idToken/uid)' }, { status: 400 });
    }

    // uid → user_code 取得（usersテーブル想定）
    const { data: userRow, error: userErr } = await supabaseAdmin
      .from('users')
      .select('user_code')
      .eq('firebase_uid', uid)
      .maybeSingle();

    if (userErr) {
      console.error('[upload-avatar] users 取得失敗', userErr);
      return NextResponse.json({ success: false, error: 'failed to fetch user_code' }, { status: 500 });
    }
    if (!userRow?.user_code) {
      return NextResponse.json({ success: false, error: 'user_code not found' }, { status: 404 });
    }

    const user_code = userRow.user_code as string;
    const filePath = `${user_code}/avatar.png`;

    // File -> Buffer
    const ab = await (file as Blob).arrayBuffer();
    let buffer = Buffer.from(ab);

    // -------- リサイズ（sharp が使えれば 256x256 の PNG に統一）--------
    let contentType: string = 'image/png';
    try {
      // 動的 import（無ければフォールバック）
      const sharpMod = await import('sharp').catch(() => null);
      if (sharpMod?.default) {
        const sharp = sharpMod.default;
        buffer = await sharp(buffer)
          .rotate() // EXIFの向き補正
          .resize(256, 256, { fit: 'cover', position: 'centre' })
          .png({ quality: 90 })
          .toBuffer();
        contentType = 'image/png';
      } else {
        // sharp が無い環境 → 受け取った contentType を尊重（なければ png）
        contentType = (file.type && /^image\//.test(file.type)) ? file.type : 'image/png';
        console.warn('[upload-avatar] sharp が見つからないため、リサイズせずにアップロードします');
      }
    } catch (e) {
      // 例外時もフォールバック
      contentType = (file.type && /^image\//.test(file.type)) ? file.type : 'image/png';
      console.warn('[upload-avatar] リサイズ処理失敗: フォールバックでそのまま保存します', e);
    }
    // -----------------------------------------------------------------

    // Storage にアップロード（Service Role なので RLS を気にしなくてOK）
    const { error: upErr } = await supabaseAdmin
      .storage.from('avatars')
      .upload(filePath, buffer, {
        upsert: true,
        contentType,
        cacheControl: '3600',
      });

    if (upErr) {
      console.error('[upload-avatar] Storage失敗', upErr);
      return NextResponse.json({ success: false, error: upErr.message }, { status: 400 });
    }

    // profiles に保存（avatar_url はパスを保持）
    const { error: profErr } = await supabaseAdmin
      .from('profiles')
      .upsert({ user_code, avatar_url: filePath, updated_at: new Date().toISOString() });

    if (profErr) {
      console.error('[upload-avatar] profiles upsert失敗', profErr);
      return NextResponse.json({ success: false, error: profErr.message }, { status: 400 });
    }

    // 公開URL（バケット public 前提）
    const { data: pub } = supabaseAdmin.storage.from('avatars').getPublicUrl(filePath);

    return NextResponse.json({
      success: true,
      filePath,
      publicUrl: pub.publicUrl,
    });
  } catch (e: any) {
    console.error('[upload-avatar] 例外', e?.message || e);
    return NextResponse.json({ success: false, error: 'internal error' }, { status: 500 });
  }
}
