// src/app/api/iros-logs/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

// === DB Row 型（self_acceptance カラムは無し） ===
type IrosMessageRow = {
  id: string;
  conversation_id: string;
  user_code: string | null;
  role: string;
  text: string | null;
  q_code: string | null;
  depth_stage: string | null;
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

/** meta から SelfAcceptance を抽出（なければ null） */
function extractSelfAcceptance(meta: unknown): number | null {
  if (!meta || typeof meta !== 'object') return null;
  const m: any = meta;

  // 直接 meta.selfAcceptance / self_acceptance
  if (typeof m.selfAcceptance === 'number') return m.selfAcceptance;
  if (typeof m.self_acceptance === 'number') return m.self_acceptance;

  // unified 内に入っているパターンも一応見る
  if (m.unified && typeof m.unified === 'object') {
    const u: any = m.unified;
    if (typeof u.selfAcceptance === 'number') return u.selfAcceptance;
    if (typeof u.self_acceptance === 'number') return u.self_acceptance;
  }

  return null;
}

// --- Viewer 互換の meta 正規化（旧UIが読むキーを補う） ---
function normalizeMetaForViewer(meta: unknown): any {
  if (!meta || typeof meta !== 'object') return meta;

  const m: any = meta;

  // 既に旧キーがあるなら尊重（上書きしない）
  const u: any = m.unified && typeof m.unified === 'object' ? m.unified : null;
  const il: any = m.intentLine && typeof m.intentLine === 'object' ? m.intentLine : null;

  // Pol / Stab（旧UIは meta.polarityBand / stabilityBand を見る）
  if (m.polarityBand == null && u?.polarityBand != null) m.polarityBand = u.polarityBand;
  if (m.polarity_band == null && u?.polarity_band != null) m.polarity_band = u.polarity_band;

  if (m.stabilityBand == null && u?.stabilityBand != null) m.stabilityBand = u.stabilityBand;
  if (m.stability_band == null && u?.stability_band != null) m.stability_band = u.stability_band;

  // mirror（旧UIは meta.mirrorMode を見るが、現状は meta.mode が本体）
  if (m.mirrorMode == null && typeof m.mode === 'string') m.mirrorMode = m.mode;
  if (m.mirror_mode == null && typeof m.mode === 'string') m.mirror_mode = m.mode;

  // I-layer（旧UIは meta.intentLayer を見る。今は intentLine.focusLayer がそれ）
  if (m.intentLayer == null && typeof il?.focusLayer === 'string') m.intentLayer = il.focusLayer;
  if (m.intent_layer == null && typeof il?.focusLayer === 'string') m.intent_layer = il.focusLayer;

  // intent（旧UIは meta.intentLine “文字列” を表示している）
  // 新構造の短いラベル候補：unified.intent_anchor.text → intent_anchor.text → situation.summary
  if (typeof m.intentLine !== 'string' || !m.intentLine) {
    const intentText =
      (typeof u?.intent_anchor?.text === 'string' && u.intent_anchor.text) ||
      (typeof m?.intent_anchor?.text === 'string' && m.intent_anchor.text) ||
      (typeof u?.situation?.summary === 'string' && u.situation.summary) ||
      '';
    if (intentText) m.intentLine = intentText;
  }

  return m;
}



export async function GET(req: NextRequest) {
  // Sofia-logs と同じく URL / KEY を渡す
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL as string,
    process.env.SUPABASE_SERVICE_ROLE_KEY as string,
  );

  const { searchParams } = new URL(req.url);
  const userCode = searchParams.get('user_code');
  const convId = searchParams.get('conv_id');
  const wantUserList = searchParams.get('user_list') === '1';

  // --- user_list=1 → ユーザー一覧モード ---
  if (wantUserList) {
    const { data, error } = await supabase
      .from('iros_messages')
      .select('user_code')
      .not('user_code', 'is', null)
      .order('user_code', { ascending: true });

    if (error) {
      console.error('[IROS-LOGS][USER_LIST] Supabase error:', error);
      return NextResponse.json(
        { error: 'Failed to fetch user list.' },
        { status: 500 },
      );
    }

    const users = Array.from(
      new Set((data || []).map((r: any) => String(r.user_code))),
    );
    return NextResponse.json({ users });
  }

  // user_code も conv_id も無い場合はエラー
  if (!userCode && !convId) {
    return NextResponse.json(
      { error: 'Missing query: "user_code" or "conv_id" is required.' },
      { status: 400 },
    );
  }

  // --- 会話一覧モード（conv_id 無し & user_code 有り） ---
  if (!convId && userCode) {
    const { data, error } = await supabase
      .from('iros_messages')
      .select('conversation_id, user_code, created_at')
      .eq('user_code', userCode)
      .order('created_at', { ascending: false }) // ★ 最新のメッセージから
      .limit(2000); // ★ 最大 2000 行だけ取得（必要に応じて増やせる）

    if (error) {
      console.error('[IROS-LOGS][LIST] Supabase error:', error);
      return NextResponse.json(
        { error: 'Failed to fetch iros_messages.' },
        { status: 500 },
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
        // 最初に来た行は「とりあえず」両方に入れておく
        convMap.set(row.conversation_id, {
          id: row.conversation_id,
          user_code: row.user_code,
          created_at: row.created_at,
          last_turn_at: row.created_at,
          turns_count: 1,
        });
      } else {
        // created_at は「最古」、last_turn_at は「最新」になるように調整
        if (
          !existing.created_at ||
          Date.parse(row.created_at) < Date.parse(existing.created_at)
        ) {
          existing.created_at = row.created_at;
        }
        if (
          !existing.last_turn_at ||
          Date.parse(row.created_at) > Date.parse(existing.last_turn_at)
        ) {
          existing.last_turn_at = row.created_at;
        }
        existing.turns_count += 1;
      }
    }

    const conversations = Array.from(convMap.values()).sort((a, b) => {
      const ta = a.last_turn_at ? Date.parse(a.last_turn_at) : 0;
      const tb = b.last_turn_at ? Date.parse(b.last_turn_at) : 0;
      return tb - ta; // 最終発話が新しい会話が上に来る
    });

    return NextResponse.json({ conversations });
  }


  // --- 会話詳細モード（conv_id 指定） ---
  if (!convId) {
    return NextResponse.json(
      { error: 'conv_id is required for conversation detail.' },
      { status: 400 },
    );
  }

  const { data: rows, error: detailError } = await supabase
    .from('iros_messages')
    .select(
      // ★ self_acceptance カラムは読まない
      'id, conversation_id, user_code, role, text, q_code, depth_stage, meta, created_at',
    )
    .eq('conversation_id', convId)
    .order('created_at', { ascending: true });

  if (detailError) {
    console.error('[IROS-LOGS][DETAIL] Supabase error:', detailError);
    return NextResponse.json(
      { error: 'Failed to fetch conversation detail.' },
      { status: 500 },
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

    const metaNorm = normalizeMetaForViewer(row.meta);
    const sa = extractSelfAcceptance(metaNorm);

    return {
      id: row.id,
      conv_id: row.conversation_id,
      role: normalizedRole,
      content: row.text,
      q_code: row.q_code,
      depth_stage: row.depth_stage,
      self_acceptance: sa,
      meta: metaNorm, // ★ここ
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
