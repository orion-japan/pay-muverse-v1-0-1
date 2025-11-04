// src/app/api/practice/calendar/route.ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { createClient } from '@supabase/supabase-js';

function resolveProjectId(): string | undefined {
  return (
    process.env.FIREBASE_PROJECT_ID || process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || undefined
  );
}
try {
  const projectId = resolveProjectId();
  initializeApp({ credential: applicationDefault(), ...(projectId ? { projectId } : {}) });
} catch {}

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE =
  process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_SERVICE_ROLE_KEY!;
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);

function jstMonthRange(ym: string) {
  const [y, m] = ym.split('-').map(Number);
  const sJ = new Date(Date.UTC(y, m - 1, 1, 0, 0, 0));
  const eJ = new Date(Date.UTC(y, m, 1, 0, 0, 0));
  return {
    startUTC: new Date(sJ.getTime() - 9 * 3600 * 1000).toISOString(),
    endUTC: new Date(eJ.getTime() - 9 * 3600 * 1000).toISOString(),
  };
}

async function getUserCode(req: NextRequest): Promise<string> {
  const authz = req.headers.get('authorization') || '';
  const token = authz.startsWith('Bearer ') ? authz.slice(7) : '';
  if (!token) throw new Error('401');
  const decoded = await getAuth().verifyIdToken(token);
  return (decoded as any).user_code || decoded.uid;
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const month = searchParams.get('month'); // 'YYYY-MM'
  if (!month) return NextResponse.json({ error: 'month is required' }, { status: 400 });

  try {
    const user_code = await getUserCode(req);
    const { startUTC, endUTC } = jstMonthRange(month);

    const { data, error } = await supabase
      .from('daily_checks')
      .select('created_at')
      .eq('user_code', user_code)
      .gte('created_at', startUTC)
      .lt('created_at', endUTC);

    if (error) throw error;

    const days: Record<string, number> = {};
    for (const r of data ?? []) {
      const jst = new Date(new Date(r.created_at as string).getTime() + 9 * 3600 * 1000);
      const key = `${jst.getUTCFullYear()}-${String(jst.getUTCMonth() + 1).padStart(2, '0')}-${String(jst.getUTCDate()).padStart(2, '0')}`;
      days[key] = (days[key] ?? 0) + 1;
    }
    return NextResponse.json({ days });
  } catch (e: any) {
    if (e?.message === '401') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    return NextResponse.json({ error: e?.message || 'internal error' }, { status: 500 });
  }
}
