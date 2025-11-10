// src/app/api/upload-avatar/route.ts
export const runtime = 'nodejs';

import { NextResponse } from 'next/server';
import { Buffer } from 'node:buffer';
import { adminAuth } from '@/lib/firebase-admin';
// 型定義が未整備でもビルドを通すために一旦許容
// @ts-ignore
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const file = form.get('file') as File | null;
    const idToken = (form.get('idToken') as string | null) ?? null;
    let uid = (form.get('uid') as string | null) ?? null;

    if (!file) {
      return NextResponse.json({ success: false, error: 'Missing file' }, { status: 400 });
    }

    // idToken が来ていれば Admin で検証して uid を確定
    if (idToken) {
      const decoded = await adminAuth.verifyIdToken(idToken, true);
      uid = decoded.uid;
    }
    if (!uid) {
      return NextResponse.json(
        { success: false, error: 'Missing uid (no idToken/uid)' },
        { status: 400 },
      );
    }

    // uid -> user_code 取得
    const { data: userRow, error: userErr } = await supabaseAdmin
      .from('users')
      .select('user_code')
      .eq('firebase_uid', uid)
      .maybeSingle();

    if (userErr) {
      console.error('[upload-avatar] users fetch failed', userErr);
      return NextResponse.json({ success: false, error: 'failed to fetch user_code' }, { status: 500 });
    }
    if (!userRow?.user_code) {
      return NextResponse.json({ success: false, error: 'user_code not found' }, { status: 404 });
    }

    const user_code: string = String(userRow.user_code);
    const filePath = `${user_code}/avatar.png`;

    // File -> Buffer
    const ab = await (file as Blob).arrayBuffer();
    let buffer: Buffer = Buffer.from(ab);

    // -------- リサイズ（sharp があれば 512x512 PNG に統一）--------
    let contentType: string = 'image/png';
    try {
      // 動的 import（依存が無い環境ではフォールバック）
      const sharpMod = await import('sharp').catch(() => null as any);
      const sharp = sharpMod?.default as (input: Buffer) => any;

      if (typeof sharp === 'function') {
        buffer = (await sharp(buffer).resize(512, 512, { fit: 'cover' }).toBuffer()) as Buffer;
        contentType = 'image/png';
      } else {
        contentType = file.type && /^image\//.test(file.type) ? file.type : 'image/png';
        console.warn('[upload-avatar] sharp not found: upload original without resize');
      }
    } catch (e) {
      contentType = file.type && /^image\//.test(file.type) ? file.type : 'image/png';
      console.warn('[upload-avatar] resize failed, fallback original', e);
    }
    // -----------------------------------------------------------------

    // Storage にアップロード（Service Role）
    const { error: upErr } = await supabaseAdmin.storage.from('avatars').upload(filePath, buffer, {
      upsert: true,
      contentType,
      cacheControl: '3600',
    });
    if (upErr) {
      console.error('[upload-avatar] storage upload failed', upErr);
      return NextResponse.json({ success: false, error: upErr.message }, { status: 400 });
    }

    // profiles を更新（avatar_url はパス保持）
    const { error: profErr } = await supabaseAdmin
      .from('profiles')
      .upsert({ user_code, avatar_url: filePath, updated_at: new Date().toISOString() });
    if (profErr) {
      console.error('[upload-avatar] profiles upsert failed', profErr);
      return NextResponse.json({ success: false, error: profErr.message }, { status: 400 });
    }

    // 公開URL（バケット public 前提）
    const { data: pub } = supabaseAdmin.storage.from('avatars').getPublicUrl(filePath);

    return NextResponse.json({
      success: true,
      filePath,
      publicUrl: pub?.publicUrl ?? null,
    });
  } catch (e: any) {
    console.error('[upload-avatar] unexpected', e?.message || e);
    return NextResponse.json({ success: false, error: 'internal error' }, { status: 500 });
  }
}
