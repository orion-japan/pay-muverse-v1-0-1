import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { isArchiveDue } from '@/lib/visionArchive';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

/**
 * POST /api/visions/auto-archive
 * - 対象: result_status IS NOT NULL AND archived_at IS NULL
 * - resulted_at + {7|14|21}日 を過ぎたものを一括で archived_at=now に更新
 */
export async function POST(req: NextRequest) {
  try {
    const userCode =
      req.headers.get('x-user-code') || new URL(req.url).searchParams.get('user_code');
    if (!userCode) return NextResponse.json({ error: 'missing user_code' }, { status: 401 });

    const { data, error } = await supabase
      .from('visions')
      .select('vision_id, phase, resulted_at, result_status, archived_at')
      .eq('user_code', userCode)
      .not('result_status', 'is', null)
      .is('archived_at', null);

    if (error) throw error;

    const due = (data ?? []).filter((v) =>
      isArchiveDue(v.resulted_at as string | null, v.phase as string | null),
    );
    if (due.length === 0) return NextResponse.json({ archived: [] });

    const now = new Date().toISOString();
    const updates = due.map((v) =>
      supabase
        .from('visions')
        .update({ archived_at: now })
        .eq('vision_id', v.vision_id)
        .eq('user_code', userCode),
    );
    const results = await Promise.all(updates);
    const firstErr = results.find((r) => (r as any).error)?.error;
    if (firstErr) throw firstErr;

    return NextResponse.json({ archived: due.map((v) => v.vision_id) });
  } catch (e: any) {
    console.error('[auto-archive]', e);
    return NextResponse.json({ error: e?.message || 'server error' }, { status: 500 });
  }
}
