// src/app/api/visions/auto-pause/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { isOverdue } from '@/lib/visionAutoPause';

// ★ .env.local に設定してください
// SUPABASE_URL=...
// SUPABASE_SERVICE_ROLE_KEY=...
const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL as string,
  process.env.SUPABASE_SERVICE_ROLE_KEY as string
);

// アクティブ扱いから除外する状態
const EXCLUDE_STATUSES = ['達成', '保留', '意図チェンジ', '破棄'] as const;

export async function POST(req: NextRequest) {
  try {
    // ---- ユーザー識別（簡易）----
    // ヘッダ優先。無ければクエリ ?user_code=xxxx でも可
    const url = new URL(req.url);
    const userCode =
      req.headers.get('x-user-code') ||
      url.searchParams.get('user_code');

    if (!userCode) {
      return NextResponse.json({ error: 'missing user_code' }, { status: 401 });
    }

    // ---- 取得：アクティブなVisionのみ ----
    const { data: visions, error: fetchErr } = await supabaseAdmin
      .from('visions')
      .select('vision_id, phase, last_activity_at, status')
      .eq('user_code', userCode)
      .not('status', 'in', `(${EXCLUDE_STATUSES.map(s => `"${s}"`).join(',')})`);

    if (fetchErr) throw fetchErr;

    const toPause = (visions ?? []).filter(v =>
      isOverdue(v.last_activity_at as string | null | undefined, (v.phase as 'initial'|'mid'|'final') || 'initial')
    );

    // ---- 更新：保留へ ----
    if (toPause.length > 0) {
      const now = new Date().toISOString();
      const updates = toPause.map(v =>
        supabaseAdmin
          .from('visions')
          .update({ status: '保留', ended_at: now })
          .eq('vision_id', v.vision_id)
          .eq('user_code', userCode)
      );
      // 並列で実行
      const results = await Promise.all(updates);
      const firstErr = results.find(r => r.error)?.error;
      if (firstErr) throw firstErr;
    }

    return NextResponse.json({ paused: toPause.map(v => v.vision_id) });
  } catch (e: any) {
    console.error('[auto-pause] error', e);
    return NextResponse.json({ error: e?.message || 'server error' }, { status: 500 });
  }
}
