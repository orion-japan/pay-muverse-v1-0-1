// src/app/api/practice/logs/route.ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { createClient } from '@supabase/supabase-js';

/* ===== Firebase Admin init ===== */
function resolveProjectId(): string | undefined {
  return (
    process.env.FIREBASE_PROJECT_ID || process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || undefined
  );
}
try {
  const projectId = resolveProjectId();
  initializeApp({
    credential: applicationDefault(),
    ...(projectId ? { projectId } : {}),
  });
} catch {
  /* already initialized */
}

/* ===== Supabase (service-role) ===== */
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE =
  process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_SERVICE_ROLE_KEY!;
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);

/* ===== columns (daily_checks) ===== */
const SELECT_COLS = [
  'id',
  'user_code',
  'vision_id',
  'check_date',
  'vision_imaged',
  'resonance_shared',
  'status_text',
  'diary_text',
  'progress',
  'q_code',
  'is_final',
  'created_at',
  'updated_at',
].join(',');

/* ===== helpers ===== */
async function getUserCode(req: NextRequest): Promise<string> {
  const authz = req.headers.get('authorization') || '';
  const token = authz.startsWith('Bearer ') ? authz.slice(7) : '';
  if (!token) throw new Error('401');
  const decoded = await getAuth().verifyIdToken(token);
  return (decoded as any).user_code || decoded.uid;
}

/**
 * GET /api/practice/logs?date=YYYY-MM-DD&mode=final|latest|timeline|diary
 *
 * final   : is_final=true のみ
 * latest  : final/draft 問わず updated_at の最新1件
 * timeline: final と draft を全件、created_at 昇順
 * diary   : 「保存ボタン（is_final=true）」＋「変更のある draft だけ」
 *           - status_text != '' もしくは diary_text != ''
 *           - または vision_imaged = true / resonance_shared = true
 *           - または progress > 0
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const date = searchParams.get('date'); // YYYY-MM-DD
  const mode = (searchParams.get('mode') || 'final') as 'final' | 'latest' | 'timeline' | 'diary';

  if (!date) {
    return NextResponse.json({ error: 'date is required' }, { status: 400 });
  }

  try {
    const user_code = await getUserCode(req);
    let rows: any[] = [];

    if (mode === 'final') {
      const { data, error } = await supabase
        .from('daily_checks')
        .select(SELECT_COLS)
        .eq('user_code', user_code)
        .eq('check_date', date)
        .eq('is_final', true)
        .order('created_at', { ascending: true });
      if (error) throw error;
      rows = data ?? [];
    }

    if (mode === 'latest') {
      const { data, error } = await supabase
        .from('daily_checks')
        .select(SELECT_COLS)
        .eq('user_code', user_code)
        .eq('check_date', date)
        .in('is_final', [true, false])
        .order('updated_at', { ascending: false })
        .limit(1);
      if (error) throw error;
      rows = data ?? [];
    }

    if (mode === 'timeline') {
      const { data, error } = await supabase
        .from('daily_checks')
        .select(SELECT_COLS)
        .eq('user_code', user_code)
        .eq('check_date', date)
        .in('is_final', [true, false])
        .order('created_at', { ascending: true });
      if (error) throw error;
      rows = data ?? [];
    }

    if (mode === 'diary') {
      // ① 最終保存（必ず含める）
      const { data: finals, error: e1 } = await supabase
        .from('daily_checks')
        .select(SELECT_COLS)
        .eq('user_code', user_code)
        .eq('check_date', date)
        .eq('is_final', true)
        .order('created_at', { ascending: true });
      if (e1) throw e1;

      // ② 変更がある draft（空の自動保存は除外）
      //    PostgREST の or 構文を使用。空文字は `neq.` で除外でき、null も除外されます。
      const { data: drafts, error: e2 } = await supabase
        .from('daily_checks')
        .select(SELECT_COLS)
        .eq('user_code', user_code)
        .eq('check_date', date)
        .eq('is_final', false)
        .or(
          [
            'status_text.neq.', // 空文字でない（null も除外される）
            'diary_text.neq.',
            'progress.gt.0',
            'vision_imaged.eq.true',
            'resonance_shared.eq.true',
          ].join(','),
        )
        .order('created_at', { ascending: true });
      if (e2) throw e2;

      rows = [...(finals ?? []), ...(drafts ?? [])];
    }

    // front-end 用に整形
    const items = rows.map((r: any) => ({
      id: r.id,
      habit_name: null,
      vision_checked: !!r.vision_imaged,
      resonance_checked: !!r.resonance_shared,
      mood_text: r.status_text ?? null,
      memo_text: r.diary_text ?? null,
      progress: r.progress ?? 0,
      q_code: r.q_code ?? null,
      check_date: r.check_date,
      is_final: !!r.is_final,
      created_at: r.created_at,
      updated_at: r.updated_at,
      vision_id: r.vision_id,
    }));

    return NextResponse.json({ items });
  } catch (e: any) {
    if (e?.message === '401') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    return NextResponse.json({ error: e?.message || 'internal error' }, { status: 500 });
  }
}
