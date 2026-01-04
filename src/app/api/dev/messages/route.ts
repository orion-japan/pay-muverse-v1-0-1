import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const conversationId = String(url.searchParams.get('conversation_id') ?? '').trim();
    if (!conversationId) {
      return NextResponse.json({ ok: false, error: 'missing conversation_id' }, { status: 400 });
    }

    // ✅ 既に reply で使えてるはずの env をそのまま使う
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

    if (!supabaseUrl || !serviceKey) {
      return NextResponse.json(
        { ok: false, error: 'missing SUPABASE env', hasUrl: !!supabaseUrl, hasKey: !!serviceKey },
        { status: 500 },
      );
    }

    const sb = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data, error } = await sb
      .from('iros_messages')
      .select('id, role, content, created_at')
      .eq('conversation_id', conversationId)
      .order('id', { ascending: false })
      .limit(5);

    if (error) {
      return NextResponse.json({ ok: false, error: error.message, detail: error.details }, { status: 500 });
    }

    return NextResponse.json({ ok: true, rows: data ?? [] });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }
}
