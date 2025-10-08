export const runtime = 'nodejs';
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

function mustEnv(n:string){ const v=process.env[n]; if(!v) throw new Error(`Missing ${n}`); return v; }
const supa = createClient(mustEnv('NEXT_PUBLIC_SUPABASE_URL'), mustEnv('SUPABASE_SERVICE_ROLE_KEY'));

export async function POST(req: NextRequest) {
  const body = await req.json() as {
    user_code: string;
    images: string[];            // storage URL[]
    ocr_text: string;            // 全文（整形後）
    meta?: any;                  // {pages:[{url,text}], lang, device, ...}
  };

  // 1) seed を発行
  const { data: seedRow, error: e1 } = await supa
    .from('mui_ocr_seeds')
    .insert({
      user_code: body.user_code,
      images: body.images,
      ocr_text: body.ocr_text,
      meta: body.meta ?? {},
    })
    .select('*')
    .single();
  if (e1) return NextResponse.json({ ok:false, error:e1.message }, { status:500 });

  // 2) ついでに “直近OCR” を見返せるよう軽いログ（任意）
  await supa.from('mui_chat_logs').insert({
    user_id: null,                // 使ってなければ null でOK
    conversation_code: seedRow.seed_id,
    role: 'user',
    content: `[OCR] ${body.ocr_text.slice(0,300)}...`,
    ocr: true,
    media_urls: body.images,
  });

  return NextResponse.json({ ok:true, seed_id: seedRow.seed_id });
}
