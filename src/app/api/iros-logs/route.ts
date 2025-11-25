// src/app/api/iros-logs/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

// === DB Row 型（参考） ===
type IrosMessageRow = {
  id: string;
  conversation_id: string;
  user_code: string | null;
  role: string;
  text: string | null;
  q_code: string | null;
  depth_stage: string | null;
  self_acceptance: number | null;
  meta: unknown | null;
  created_at: string;
};

// 会話一覧用サマリ
type IrosConversationSummary = {
  id: string; // conversation_id
  user_code: string | null;
  created_at: string | null;
  last_turn_at: string | null;
  turns_count: number;
};

// Mu 互換の turn 形式（Viewer 側で扱いやすく）
type IrosTurn = {
  id: string;
  conv_id: string;
  role: 'user' | 'assistant' | string;
  content: string | null;
  q_code: string | null;
  depth_stage: string | null;
  self_acceptance: number | null;
  meta: unknown | null;
  used_credits: number | null;
  created_at: string;
};

export async function GET(req: NextRequest) {
  // ✨ ここを修正：URL / KEY を渡す
  // （sofia-logs の route.ts で使っている行と同じにしてください）
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL as string,
    process.env.SUPABASE_SERVICE_ROLE_KEY as string
  );

  const { searchParams } = new URL(req.url);
  const userCode = searchParams.get('user_code');
  const convId = searchParams.get('conv_id');

  // user_code も conv_id も無い場合はエラー
  if (!userCode && !convId) {
    return NextResponse.json(
      { error: 'Missing query: "user_code" or "conv_id" is required.' },
      { status: 400 }
    );
  }

  // conv_id が無い → 会話一覧モード
  if (!convId && userCode) {
    const { data, error } = await supabase
      .from('iros_messages')
      .select('conversation_id, user_code, created_at')
      .eq('user_code', userCode)
      .order('created_at', { ascending: true });

    if (error) {
      console.error('[IROS-LOGS][LIST] Supabase error:', error);
      return NextResponse.json(
        { error: 'Failed to fetch iros_messages.' },
        { status: 500 }
      );
    }

    if (!data || data.length === 0) {
      const empty: IrosConversationSummary[] = [];
      return NextResponse.json({ conversations: empty });
    }

    const convMap = new Map<string, IrosConversationSummary>();

    for (const row of data as IrosMessageRow[]) {
      const existing = convMap.get(row.conversation_id);
      if (!existing) {
        convMap.set(row.conversation_id, {
          id: row.conversation_id,
          user_code: row.user_code,
          created_at: row.created_at,
          last_turn_at: row.created_at,
          turns_count: 1,
        });
      } else {
        existing.last_turn_at = row.created_at;
        existing.turns_count += 1;
      }
    }

    const conversations = Array.from(convMap.values()).sort((a, b) => {
      const ta = a.last_turn_at ? Date.parse(a.last_turn_at) : 0;
      const tb = b.last_turn_at ? Date.parse(b.last_turn_at) : 0;
      return tb - ta;
    });

    return NextResponse.json({ conversations });
  }

  // conv_id 指定 → 会話詳細モード
  if (!convId) {
    return NextResponse.json(
      { error: 'conv_id is required for conversation detail.' },
      { status: 400 }
    );
  }

  const { data: rows, error: detailError } = await supabase
    .from('iros_messages')
    .select(
      'id, conversation_id, user_code, role, text, q_code, depth_stage, self_acceptance, meta, created_at'
    )
    .eq('conversation_id', convId)
    .order('created_at', { ascending: true });

  if (detailError) {
    console.error('[IROS-LOGS][DETAIL] Supabase error:', detailError);
    return NextResponse.json(
      { error: 'Failed to fetch conversation detail.' },
      { status: 500 }
    );
  }

  if (!rows || rows.length === 0) {
    return NextResponse.json({
      conversation: null,
      turns: [] as IrosTurn[],
      turns_count: 0,
    });
  }

  const typedRows = rows as IrosMessageRow[];

  const turns: IrosTurn[] = typedRows.map((row) => {
    const normalizedRole =
      row.role === 'user' || row.role === 'assistant'
        ? row.role
        : row.role ?? 'assistant';

    return {
      id: row.id,
      conv_id: row.conversation_id,
      role: normalizedRole,
      content: row.text,
      q_code: row.q_code,
      depth_stage: row.depth_stage,
      self_acceptance: row.self_acceptance,
      meta: row.meta,
      used_credits: null,
      created_at: row.created_at,
    };
  });

  const first = typedRows[0];
  const last = typedRows[typedRows.length - 1];

  const conversation = {
    id: convId,
    user_code: first.user_code,
    created_at: first.created_at,
    last_turn_at: last.created_at,
    updated_at: last.created_at,
  };

  return NextResponse.json({
    conversation,
    turns,
    turns_count: turns.length,
  });
}
