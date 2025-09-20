// src/app/api/sofia-logs/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_ROLE =
  process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_SERVICE_ROLE_KEY!;
const DEBUG = process.env.DEBUG_OPS_SOFIALOGS === '1';

type SofiaConversation = {
  id: string;
  user_code: string;
  title: string | null;
  origin_app: string | null;
  conversation_code: string | null; // ← 型に追加
  last_turn_at: string | null;
  created_at: string | null;
  updated_at: string | null;
};

type SofiaTurnRaw = {
  id: string;
  conversation_code: string;
  turn_index: number | null;
  created_at: string | null;
  user_text: string | null;
  user_message: string | null;
  assistant_text: string | null;
  reply: string | null;
  meta: any | null;
  used_credits: number | null;
  agent: string | null;
  sub_id: string | null;
  status: string | null;
  sub_code: string | null;
};

type MuLikeTurn = {
  id: string;
  conv_id: string; // sofia_conversations.id を返す
  role: 'user' | 'assistant';
  content: string | null;
  meta: any | null;
  used_credits: number | null;
  source_app: string | null;
  sub_id: string | null;
  attachments: null;
  created_at: string | null;
};

function sbAdmin() {
  return createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });
}

const CONV_FIELDS =
  'id,user_code,title,origin_app,conversation_code,last_turn_at,created_at,updated_at';

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const user_code = url.searchParams.get('user_code')?.trim() || null;
  const conv_id = url.searchParams.get('conv_id')?.trim() || null;
  const pageSize = Math.max(1, Math.min(200, Number(url.searchParams.get('page_size') || 50)));

  try {
    const sb = sbAdmin();

    if (conv_id) {
      // 会話1件
      const { data: convo, error: cErr } = await sb
        .from('sofia_conversations')
        .select(CONV_FIELDS)
        .eq('id', conv_id)
        .maybeSingle<SofiaConversation>(); // ← 型指定

      if (cErr) return NextResponse.json({ error: cErr.message }, { status: 500 });
      if (!convo) return NextResponse.json({ error: 'conversation not found' }, { status: 404 });

      const code = convo.conversation_code;
      if (!code) {
        return NextResponse.json({ conversation: convo, turns: [], turns_count: 0 });
      }

      // 件数
      const { count: turnsCount } = await sb
        .from('sofia_turns')
        .select('id', { count: 'exact', head: true })
        .eq('conversation_code', code);

      // Sofiaの行を取得（conv_id/role/content は無い！）
      const { data: raw, error: tErr } = await sb
        .from('sofia_turns')
        .select(
          [
            'id',
            'conversation_code',
            'turn_index',
            'created_at',
            'user_text',
            'user_message',
            'assistant_text',
            'reply',
            'meta',
            'used_credits',
            'agent',
            'sub_id',
            'status',
            'sub_code',
          ].join(',')
        )
        .eq('conversation_code', code)
        .order('turn_index', { ascending: true })
        .order('created_at', { ascending: true })
        .limit(2000)
        .returns<SofiaTurnRaw[]>(); // ← 型指定

      if (tErr) return NextResponse.json({ error: tErr.message }, { status: 500 });

      // Mu風ターンに展開
      const turns: MuLikeTurn[] = [];
      for (const r of raw ?? []) {
        const userContent = r.user_text ?? r.user_message ?? null;
        const asstContent = r.assistant_text ?? r.reply ?? null;

        if (userContent) {
          turns.push({
            id: `${r.id}:u`,
            conv_id: convo.id,
            role: 'user',
            content: userContent,
            meta: r.meta ?? null,
            used_credits: null,
            source_app: r.agent ?? null,
            sub_id: r.sub_id ?? null,
            attachments: null,
            created_at: r.created_at,
          });
        }
        if (asstContent) {
          turns.push({
            id: `${r.id}:a`,
            conv_id: convo.id,
            role: 'assistant',
            content: asstContent,
            meta: r.meta ?? null,
            used_credits: r.used_credits ?? null,
            source_app: r.agent ?? null,
            sub_id: r.sub_id ?? null,
            attachments: null,
            created_at: r.created_at,
          });
        }
      }

      return NextResponse.json({
        conversation: convo,
        turns,
        turns_count: turnsCount ?? turns.length,
      });
    }

    if (user_code) {
      const { data: conversations, error: listErr } = await sb
        .from('sofia_conversations')
        .select(CONV_FIELDS)
        .eq('user_code', user_code)
        .order('last_turn_at', { ascending: false, nullsFirst: false })
        .order('created_at', { ascending: false })
        .limit(pageSize)
        .returns<SofiaConversation[]>(); // ← 型指定

      if (listErr) return NextResponse.json({ error: listErr.message }, { status: 500 });

      return NextResponse.json({ conversations: conversations ?? [] });
    }

    return NextResponse.json({ error: 'Specify either user_code or conv_id.' }, { status: 400 });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'failed' }, { status: 500 });
  }
}
