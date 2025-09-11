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
      return NextResponse.json(
        { error: 'missing user_code' },
        { status: 401 }
      );
    }

    const debug = url.searchParams.get('debug') === '1';

    const baseSelect =
      'vision_id,title,status,phase,moved_to_history_at,archived_at,q_code,iboard_thumb';

    // A: status ∈ HISTORY_STATUSES
    const byStatus = await supabase
      .from('visions')
      .select(baseSelect)
      .eq('user_code', userCode)
      .in('status', [...HISTORY_STATUSES]);

    // B: moved_to_history_at IS NOT NULL
    const byMoved = await supabase
      .from('visions')
      .select(baseSelect)
      .eq('user_code', userCode)
      .not('moved_to_history_at', 'is', null);

    // C: archived_at IS NOT NULL
    const byArchived = await supabase
      .from('visions')
      .select(baseSelect)
      .eq('user_code', userCode)
      .not('archived_at', 'is', null);

    if (byStatus.error) throw byStatus.error;
    if (byMoved.error) throw byMoved.error;
    if (byArchived.error) throw byArchived.error;

    // 重複を除去してマージ
    const map = new Map<string, any>();
    for (const r of byStatus.data ?? []) map.set(String(r.vision_id), r);
    for (const r of byMoved.data ?? []) map.set(String(r.vision_id), r);
    for (const r of byArchived.data ?? []) map.set(String(r.vision_id), r);

    // 日付で降順ソート
    const items = Array.from(map.values()).sort((a: any, b: any) => {
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
        _debug: {
          userCode,
          counts: {
            byStatus: byStatus.data?.length ?? 0,
            byMoved: byMoved.data?.length ?? 0,
            byArchived: byArchived.data?.length ?? 0,
          },
          statuses: HISTORY_STATUSES,
        },
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
