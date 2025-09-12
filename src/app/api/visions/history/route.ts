// src/app/api/visions/history/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// 実データの表記に合わせる
const HISTORY_STATUSES = ['達成', '保留', '意図違い', '破棄'] as const;

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const userCode =
      req.headers.get('x-user-code') ||
      url.searchParams.get('user_code') ||
      '';

    if (!userCode) {
      return NextResponse.json({ error: 'missing user_code' }, { status: 401 });
    }

    const debug = url.searchParams.get('debug') === '1';

    const baseSelect =
      'vision_id,title,status,phase,moved_to_history_at,archived_at,q_code,iboard_thumb';

    // 3条件を OR でまとめて1クエリに
    // status.in.(...) OR moved_to_history_at IS NOT NULL OR archived_at IS NOT NULL
    const orClause = [
      `status.in.(${HISTORY_STATUSES.join(',')})`,
      'moved_to_history_at.not.is.null',
      'archived_at.not.is.null',
    ].join(',');

    const { data, error } = await supabase
      .from('visions')
      .select(baseSelect)
      .eq('user_code', userCode)
      .or(orClause);

    if (error) throw error;

    // 並び替え：coalesce(moved_to_history_at, archived_at) DESC
    const items = (data ?? []).sort((a: any, b: any) => {
      const ta =
        Date.parse(a.moved_to_history_at ?? '') ||
        Date.parse(a.archived_at ?? '') ||
        0;
      const tb =
        Date.parse(b.moved_to_history_at ?? '') ||
        Date.parse(b.archived_at ?? '') ||
        0;
      return tb - ta;
    });

    if (debug) {
      return NextResponse.json({
        items,
        _debug: { userCode, count: data?.length ?? 0, statuses: HISTORY_STATUSES },
      });
    }

    return NextResponse.json({ items });
  } catch (e: any) {
    console.error('[history] error', e);
    return NextResponse.json(
      { error: e?.message || 'server error' },
      { status: 500 }
    );
  }
}
