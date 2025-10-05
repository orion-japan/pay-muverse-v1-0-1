// src/app/api/fshot/save/route.ts
export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const URL  = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SRV  = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const BUCKET = 'mui-fshot';

const json = (d:any, s=200) => new NextResponse(JSON.stringify(d), {
  status: s,
  headers: { 'content-type': 'application/json; charset=utf-8' },
});

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const file = form.get('file') as File | null;
    const ocr  = String(form.get('ocr_text') || '');
    const user = String(form.get('user_code') || 'ANON');
    const conv = (form.get('conversation_code') || null) as string | null;

    if (!file) return json({ ok:false, error:'no file' }, 400);

    // Service Role があれば優先。無ければ anon で（RLSポリシーが許可済）
    const KEY = SRV || ANON;
    const sb = createClient(URL, KEY, { auth: { persistSession: false } });

    const name = (file as any).name || 'upload';
    const ext  = name.includes('.') ? name.split('.').pop()!.toLowerCase() : 'jpg';
    const path = `ocr/${user}/${Date.now()}.${ext}`; // 先頭に「/」は付けない

    // アップロード
    const { error: upErr } = await sb.storage
      .from(BUCKET)
      .upload(path, file, { contentType: file.type, upsert: false });

    if (upErr) {
      // ここで原因をはっきり返す（Bucket not found, RLS, path不正など）
      return json({ ok:false, stage:'upload', error: upErr.message, bucket: BUCKET, path }, 500);
    }

    // 公開URL取得（public バケット前提）
    const { data: pub } = sb.storage.from(BUCKET).getPublicUrl(path);
    const url = pub?.publicUrl ?? null;

    // （任意）OCR本文などを DB に保存したい場合はここで insert
    // await sb.from('mu_fshot_sessions').insert({ ... })

    return json({ ok:true, bucket: BUCKET, path, url, ocr, conversation_code: conv, user });
  } catch (e:any) {
    return json({ ok:false, stage:'catch', error: e?.message || String(e) }, 500);
  }
}
