// src/app/api/practice/draft/route.ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { createClient } from '@supabase/supabase-js';

try {
  initializeApp({ credential: applicationDefault() });
} catch {}

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

async function getUserCode(req: NextRequest) {
  const h = req.headers.get('authorization') || '';
  const t = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!t) throw new Error('401');
  const dec = await getAuth().verifyIdToken(t);
  return (dec as any).user_code || dec.uid;
}

const SELECT_COLS =
  'id,user_code,vision_id,check_date,vision_imaged,resonance_shared,status_text,diary_text,progress,q_code,is_final,created_at,updated_at';

export async function POST(req: NextRequest) {
  try {
    const user_code = await getUserCode(req);
    const body = await req.json();

    if (!body.check_date) {
      return NextResponse.json({ error: 'check_date is required' }, { status: 400 });
    }

    // 既存の「下書き（is_final=false）」を探す
    const { data: draft } = await supabase
      .from('daily_checks')
      .select('id')
      .eq('user_code', user_code)
      .eq('check_date', body.check_date)
      .eq('is_final', false)
      .maybeSingle();

    const payload = {
      user_code,
      vision_id: body.vision_id ?? null,
      check_date: body.check_date,
      vision_imaged: !!body.vision_imaged,
      resonance_shared: !!body.resonance_shared,
      status_text: body.status_text ?? null,
      diary_text: body.diary_text ?? null,
      progress: body.progress ?? 0,
      q_code: body.q_code ?? null,
      is_final: false,
    };

    let res;
    if (draft?.id) {
      // 上書き（下書き1件を保つ）
      res = await supabase
        .from('daily_checks')
        .update(payload)
        .eq('id', draft.id)
        .select(SELECT_COLS)
        .single();
    } else {
      // 無ければ作成
      res = await supabase.from('daily_checks').insert(payload).select(SELECT_COLS).single();
    }
    if (res.error) throw res.error;
    return NextResponse.json({ row: res.data });
  } catch (e: any) {
    if (e?.message === '401') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    return NextResponse.json({ error: e?.message || 'internal error' }, { status: 500 });
  }
}
