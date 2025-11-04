// app/api/mypage/upload-avatar/route.ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { adminAuth } from '@/lib/firebase-admin';
import { createClient } from '@supabase/supabase-js';

function mustEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

const SUPABASE_URL = mustEnv('NEXT_PUBLIC_SUPABASE_URL');
const SUPABASE_SERVICE_ROLE_KEY = mustEnv('SUPABASE_SERVICE_ROLE_KEY');

export async function POST(req: NextRequest) {
  try {
    // 1) Auth
    const authz = req.headers.get('authorization') || '';
    const token = authz.toLowerCase().startsWith('bearer ') ? authz.slice(7).trim() : null;
    if (!token) return NextResponse.json({ error: 'missing token' }, { status: 401 });

    const decoded = await adminAuth.verifyIdToken(token).catch(() => null);
    if (!decoded?.uid) return NextResponse.json({ error: 'invalid token' }, { status: 401 });

    // 2) Supabase(Admin)
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // 3) user_code 解決（firebase_uid → click_email）
    let user_code: string | null = null;

    {
      const { data, error } = await supabase
        .from('users')
        .select('user_code')
        .eq('firebase_uid', decoded.uid)
        .maybeSingle();
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      if (data?.user_code) user_code = data.user_code;
    }

    if (!user_code && decoded.email) {
      const { data, error } = await supabase
        .from('users')
        .select('user_code')
        .eq('click_email', decoded.email)
        .maybeSingle();
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      if (data?.user_code) {
        user_code = data.user_code;
        await supabase
          .from('users')
          .update({ firebase_uid: decoded.uid })
          .eq('user_code', user_code);
      }
    }

    if (!user_code) {
      return NextResponse.json({ error: 'user_code not found' }, { status: 404 });
    }

    // 4) 画像受け取り（FormData: "file"）
    const form = await req.formData();
    const file = form.get('file');
    if (!(file instanceof Blob)) {
      return NextResponse.json({ error: 'file not provided' }, { status: 400 });
    }

    // 5) Storage へアップロード（Service Role なので RLS バイパス）
    const ext = 'webp'; // クライアントで webp にしている前提
    const path = `${user_code}/${Date.now()}-avatar.${ext}`;

    const arrayBuf = await file.arrayBuffer();
    const { error: upErr } = await supabase.storage
      .from('avatars')
      .upload(path, Buffer.from(arrayBuf), {
        upsert: true,
        contentType: 'image/webp',
      });
    if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 });

    // 6) profiles.avatar_url をキーで保存（upsert）
    const { error: pe } = await supabase
      .from('profiles')
      .upsert({ user_code, avatar_url: path }, { onConflict: 'user_code' });
    if (pe) return NextResponse.json({ error: pe.message }, { status: 500 });

    return NextResponse.json({ ok: true, path }, { status: 200 });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'unknown' }, { status: 500 });
  }
}
