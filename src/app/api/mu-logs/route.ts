// src/app/api/mu-logs/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_SERVICE_ROLE_KEY!;

function sbAdmin() {
  return createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { persistSession: false },
  });
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const sp = url.searchParams;

  const user_code = sp.get('user_code')?.trim() || null;
  const conv_id = sp.get('conv_id')?.trim() || null;
  const pageSize = Math.max(1, Math.min(200, Number(sp.get('page_size') || 50)));

  try {
    const sb = sbAdmin();

    if (conv_id) {
      // ── 会話詳細
      const { data: convo, error: cErr } = await sb
        .from('mu_conversations')
        .select('*') // ★ 必要なカラムだけ抽出する代わりに全部取る
        .eq('id', conv_id)
        .maybeSingle();

      if (cErr) return NextResponse.json({ error: cErr.message }, { status: 500 });
      if (!convo) return NextResponse.json({ error: 'conversation not found' }, { status: 404 });

      const { count: turnsCount } = await sb
        .from('mu_turns')
        .select('id', { count: 'exact', head: true })
        .eq('conv_id', conv_id);

      const { data: turns, error: tErr } = await sb
        .from('mu_turns')
        .select('*') // ★ こちらも全件
        .eq('conv_id', conv_id)
        .order('created_at', { ascending: true })
        .limit(2000);

      if (tErr) return NextResponse.json({ error: tErr.message }, { status: 500 });

      const conversation = {
        id: convo.id,
        user_code: convo.user_code,
        title: convo.title ?? null,
        origin_app: convo.origin_app ?? null, // 無ければ undefined のままでも問題なし
        last_turn_at: convo.last_turn_at ?? null,
        created_at: convo.created_at ?? null,
        updated_at: convo.updated_at ?? null,
      };

      return NextResponse.json({
        conversation,
        turns: (turns ?? []).map((t: any) => ({
          id: t.id,
          conv_id: t.conv_id,
          role: t.role,
          content: t.content ?? '',
          meta: t.meta ?? null,
          used_credits: t.used_credits ?? null,
          source_app: t.source_app ?? null,
          sub_id: t.sub_id ?? null,
          attachments: t.attachments ?? null,
          created_at: t.created_at ?? null,
        })),
        turns_count: turnsCount ?? (turns ?? []).length,
      });
    }

    if (user_code) {
      // ── ユーザーごとの会話一覧
      const { data: rows, error: listErr } = await sb
        .from('mu_conversations')
        .select('*')
        .eq('user_code', user_code)
        .order('last_turn_at', { ascending: false, nullsFirst: false })
        .order('created_at', { ascending: false })
        .limit(pageSize);

      if (listErr) return NextResponse.json({ error: listErr.message }, { status: 500 });

      const conversations = (rows ?? []).map((c: any) => ({
        id: c.id,
        user_code: c.user_code,
        title: c.title ?? null,
        origin_app: c.origin_app ?? null,
        last_turn_at: c.last_turn_at ?? null,
        created_at: c.created_at ?? null,
        updated_at: c.updated_at ?? null,
      }));

      return NextResponse.json({ conversations });
    }

    return NextResponse.json({ error: 'Specify either user_code or conv_id.' }, { status: 400 });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'failed' }, { status: 500 });
  }
}
