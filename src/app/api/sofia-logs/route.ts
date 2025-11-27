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
  conversation_code: string | null;
  last_turn_at: string | null;
  created_at: string | null;
  updated_at: string | null;
};

// 旧 sofia_turns 用
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

// normalized 用（テーブル定義に合わせる）
type SofiaTurnNormalized = {
  id: string;
  user_code: string | null;
  conversation_code: string;
  turn_index: number | null;
  created_at: string | null;
  user_text: string | null;
  assistant_text: string | null;
  phase: string | null;
  self_acceptance: any | null;
  relation_quality: any | null;
  q_current: string | null;
  q_next: string | null;
  layers: any | null;
  qcodes: any | null;
  trace: any | null;
};

type MuLikeTurn = {
  id: string;
  conv_id: string;
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
  return createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { persistSession: false },
  });
}

const CONV_FIELDS =
  'id,user_code,title,origin_app,conversation_code,last_turn_at,created_at,updated_at';

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const user_code = url.searchParams.get('user_code')?.trim() || null;
  const conv_id = url.searchParams.get('conv_id')?.trim() || null;
  const turnType = (url.searchParams.get('turn_type') || 'raw').toLowerCase(); // 'raw' | 'normalized'
  const pageSize = Math.max(
    1,
    Math.min(200, Number(url.searchParams.get('page_size') || 50)),
  );

  try {
    const sb = sbAdmin();

    // ===== conv_id 指定 → 会話1件 =====
    if (conv_id) {
      const { data: convo, error: cErr } = await sb
        .from('sofia_conversations')
        .select(CONV_FIELDS)
        .eq('id', conv_id)
        .maybeSingle();

      if (cErr) {
        if (DEBUG) console.error('[SofiaLogs] convo load error:', cErr);
        return NextResponse.json({ error: cErr.message }, { status: 500 });
      }
      if (!convo) {
        return NextResponse.json(
          { error: 'conversation not found' },
          { status: 404 },
        );
      }

      const code = (convo as SofiaConversation).conversation_code;
      if (!code) {
        return NextResponse.json({
          conversation: convo,
          turns: [],
          turns_count: 0,
        });
      }

      // ===== ターン件数 =====
      const baseTable =
        turnType === 'normalized' ? 'sofia_turns_normalized' : 'sofia_turns';

      const { count: turnsCount } = await sb
        .from(baseTable)
        .select('id', { count: 'exact', head: true })
        .eq('conversation_code', code);

      // ===== ターン取得（テーブルごとに分岐） =====
      let turns: MuLikeTurn[] = [];

      if (turnType === 'normalized') {
        // ---------- sofia_turns_normalized ----------
        // ★ 修正ポイント：
        //   ・まず降順（新しい順）で最大 2000 件取得
        //   ・その後 .reverse() して「最新 2000 件を古い→新しい順」に並べ替え
        const { data: rawDesc, error: tErr } = await sb
          .from('sofia_turns_normalized')
          .select(
            [
              'id',
              'user_code',
              'conversation_code',
              'turn_index',
              'created_at',
              'user_text',
              'assistant_text',
              'phase',
              'self_acceptance',
              'relation_quality',
              'q_current',
              'q_next',
              'layers',
              'qcodes',
              'trace',
            ].join(','),
          )
          .eq('conversation_code', code)
          .order('turn_index', { ascending: false, nullsFirst: false })
          .order('created_at', { ascending: false })
          .limit(2000);

        if (tErr) {
          if (DEBUG) console.error('[SofiaLogs] normalized turns error:', tErr);
          return NextResponse.json({ error: tErr.message }, { status: 500 });
        }

        const raw = (rawDesc ?? []).slice().reverse(); // 最新2000件を古い→新しい順へ

        for (const r of raw as SofiaTurnNormalized[]) {
          const meta = {
            phase: r.phase,
            self_acceptance: r.self_acceptance,
            relation_quality: r.relation_quality,
            q_current: r.q_current,
            q_next: r.q_next,
            layers: r.layers,
            qcodes: r.qcodes,
            trace: r.trace,
          };

          if (r.user_text) {
            turns.push({
              id: `${r.id}:u`,
              conv_id: convo.id,
              role: 'user',
              content: r.user_text,
              meta,
              used_credits: null,
              source_app: 'normalized',
              sub_id: null,
              attachments: null,
              created_at: r.created_at,
            });
          }
          if (r.assistant_text) {
            turns.push({
              id: `${r.id}:a`,
              conv_id: convo.id,
              role: 'assistant',
              content: r.assistant_text,
              meta,
              used_credits: null,
              source_app: 'normalized',
              sub_id: null,
              attachments: null,
              created_at: r.created_at,
            });
          }
        }
      } else {
        // ---------- 旧 sofia_turns ----------
        // ★ 同じく、最新 2000 件を取得してから reverse
        const { data: rawDesc, error: tErr } = await sb
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
            ].join(','),
          )
          .eq('conversation_code', code)
          .order('turn_index', { ascending: false, nullsFirst: false })
          .order('created_at', { ascending: false })
          .limit(2000);

        if (tErr) {
          if (DEBUG) console.error('[SofiaLogs] turns error:', tErr);
          return NextResponse.json({ error: tErr.message }, { status: 500 });
        }

        const raw = (rawDesc ?? []).slice().reverse(); // 最新2000件を古い→新しい順へ

        turns = [];
        for (const r of raw as SofiaTurnRaw[]) {
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
      }

      return NextResponse.json({
        conversation: convo,
        turns,
        turns_count: turnsCount ?? turns.length,
      });
    }

    // ===== user_code 指定 → 会話一覧 =====
    if (user_code) {
      const { data: conversations, error: listErr } = await sb
        .from('sofia_conversations')
        .select(CONV_FIELDS)
        .eq('user_code', user_code)
        .order('last_turn_at', { ascending: false, nullsFirst: false })
        .order('created_at', { ascending: false })
        .limit(pageSize);

      if (listErr) {
        if (DEBUG)
          console.error('[SofiaLogs] conversation list error:', listErr);
        return NextResponse.json({ error: listErr.message }, { status: 500 });
      }

      return NextResponse.json({ conversations: conversations ?? [] });
    }

    return NextResponse.json(
      { error: 'Specify either user_code or conv_id.' },
      { status: 400 },
    );
  } catch (e: any) {
    if (DEBUG) console.error('[SofiaLogs] fatal error:', e);
    return NextResponse.json(
      { error: e?.message || 'failed' },
      { status: 500 },
    );
  }
}
