// src/app/api/intent/person-state/route.ts
// ユーザーごとの「トピック × 対象」最新状態を返すAPI
// ソース: view iros_person_intent_state

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import {
  SUPABASE_URL,
  SERVICE_ROLE,
  verifyFirebaseAndAuthorize,
} from '@/lib/authz';

const DEBUG = process.env.DEBUG_OPS_IROS === '1';

type PersonIntentStateRow = {
  user_code: string;
  situation_topic: string | null;
  target_kind: string | null;
  target_label: string | null;
  conversation_id: string | null;
  last_created_at: string;
  last_q_code: string | null;
  last_depth_stage: string | null;
  last_self_acceptance: number | null;
  y_level: number | null;
  h_level: number | null;
};

export async function GET(req: NextRequest) {
  try {
    // 🔐 Firebase 認証 & user_code 取得
    const auth = await verifyFirebaseAndAuthorize(req);

    if (!auth.ok || !auth.allowed || !auth.userCode) {
      if (DEBUG) console.warn('[PersonState] auth failed', auth);
      return NextResponse.json(
        { ok: false, error: 'unauthorized' },
        { status: auth.status ?? 401 },
      );
    }

    const userCode = auth.userCode;

    if (DEBUG) {
      console.log('[PersonState] start', { userCode });
    }

    // 🔗 Supabase クライアント（行レベルセキュリティ用に pgJwt を付与）
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE!, {
      global: {
        headers: {
          Authorization: `Bearer ${auth.pgJwt}`,
        },
      },
    });

    // 将来的に topic / target_kind で絞り込みたい場合はここで query param を拾う
    const { searchParams } = new URL(req.url);
    const topicFilter = searchParams.get('topic');       // 例: "恋愛・パートナーシップ"
    const targetKindFilter = searchParams.get('target'); // 例: "self" / "boss"

    let query = supabase
      .from('iros_person_intent_state')
      .select(
        `
        user_code,
        situation_topic,
        target_kind,
        target_label,
        conversation_id,
        last_created_at,
        last_q_code,
        last_depth_stage,
        last_self_acceptance,
        y_level,
        h_level
      `,
      )
      .eq('user_code', userCode)
      .order('last_created_at', { ascending: false });

    if (topicFilter) {
      query = query.eq('situation_topic', topicFilter);
    }

    if (targetKindFilter) {
      query = query.eq('target_kind', targetKindFilter);
    }

    const { data, error } = await query;

    if (error) {
      console.error('[PersonState] query error', error);
      return NextResponse.json(
        { ok: false, error: 'query_failed' },
        { status: 500 },
      );
    }

    const rows = (data ?? []) as PersonIntentStateRow[];

    if (DEBUG) {
      console.log('[PersonState] rows', {
        count: rows.length,
        topics: Array.from(new Set(rows.map((r) => r.situation_topic))),
      });
    }

    return NextResponse.json({
      ok: true,
      user_code: userCode,
      rows,
    });
  } catch (e) {
    console.error('[PersonState] unexpected error', e);
    return NextResponse.json(
      { ok: false, error: 'unexpected_error' },
      { status: 500 },
    );
  }
}
