export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

function json(d: any, s = 200) {
  return new NextResponse(JSON.stringify(d), {
    status: s,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
const newConvCode = () =>
  `MU-${Math.random().toString(36).slice(2, 7)}-${Math.random().toString(36).slice(2, 5)}`;

export async function POST(req: NextRequest) {
  try {
    const b = await req.json().catch(() => ({}));
    const session_id = String(b?.session_id || '');
    const user_code = String(b?.user_code || 'DEMO');
    if (!session_id) return json({ ok: false, error: 'missing session_id' }, 400);

    const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });

    const { data: row, error } = await sb
      .from('mu_fshot_sessions')
      .select('ocr, conversation_code, status')
      .eq('id', session_id)
      .single();
    if (error) return json({ ok: false, error: error.message }, 500);

    const convCode = row?.conversation_code || newConvCode();
    const ocrBlocks: any[] = Array.isArray(row?.ocr) ? row!.ocr : [];

    // OCR テキストを 1本にまとめる（シンプル版）
    const ocrText = ocrBlocks
      .sort((a, b) => a.page_index - b.page_index || a.block_index - b.block_index)
      .map((b) => b.text_raw?.trim())
      .filter(Boolean)
      .join('\n\n')
      .slice(0, 8000);

    // ここで /api/agent/mui を呼び出して初回応答を生成（内部呼び）
    const r = await fetch(`${process.env.NEXT_PUBLIC_BASE_URL || ''}/api/agent/mui`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        conversation_code: convCode,
        messages: [
          {
            role: 'system',
            content:
              'これはFShot（画像OCR）から始まる会話です。OCR誤りは文脈で自然に補正し、Qコードの視点で最初のレポートを短く返してください。',
          },
          {
            role: 'user',
            content:
              ocrText || '（OCRで内容が抽出できませんでした。状況に応じてヒアリングして下さい。）',
          },
        ],
        model: 'gpt-4o',
        mode: 'diagnosis',
        use_kb: true,
        kb_limit: 4,
      }),
    });

    if (!r.ok) {
      const t = await r.text().catch(() => '');
      return json({ ok: false, error: `mui upstream ${r.status}`, detail: t }, 502);
    }
    const data = await r.json();
    const reply_preview: string = data?.reply ?? data?.reply_preview ?? '';
    const q = data?.q ?? { code: 'Q2' };

    // セッションを committed に
    await sb
      .from('mu_fshot_sessions')
      .update({
        status: 'committed',
        conversation_code: convCode,
        updated_at: new Date().toISOString(),
      })
      .eq('id', session_id);

    return json({
      ok: true,
      conversation_code: convCode,
      reply_preview: reply_preview?.slice(0, 600) || '',
      q,
    });
  } catch (e: any) {
    return json({ ok: false, error: String(e?.message ?? e) }, 500);
  }
}
