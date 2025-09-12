// src/app/api/practice/export/route.ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { createClient } from '@supabase/supabase-js';

function resolveProjectId(): string | undefined {
  return (
    process.env.FIREBASE_PROJECT_ID ||
    process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ||
    undefined
  );
}
try {
  const projectId = resolveProjectId();
  initializeApp({ credential: applicationDefault(), ...(projectId ? { projectId } : {}) });
} catch {}

const SUPABASE_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE =
  process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_SERVICE_ROLE_KEY!;
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);

function toRange(kind: 'day'|'month', key: string) {
  if (kind === 'day') {
    const [y, m, d] = key.split('-').map(Number);
    const sJ = new Date(Date.UTC(y, m - 1, d, 0, 0, 0));
    const eJ = new Date(Date.UTC(y, m - 1, d + 1, 0, 0, 0));
    return {
      startUTC: new Date(sJ.getTime() - 9 * 3600 * 1000).toISOString(),
      endUTC:   new Date(eJ.getTime() - 9 * 3600 * 1000).toISOString(),
      label: key,
    };
  } else {
    const [y, m] = key.split('-').map(Number);
    const sJ = new Date(Date.UTC(y, m - 1, 1, 0, 0, 0));
    const eJ = new Date(Date.UTC(y, m, 1, 0, 0, 0));
    return {
      startUTC: new Date(sJ.getTime() - 9 * 3600 * 1000).toISOString(),
      endUTC:   new Date(eJ.getTime() - 9 * 3600 * 1000).toISOString(),
      label: key,
    };
  }
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
  const kind = (searchParams.get('kind') as 'day'|'month') || 'day';
  const key  = searchParams.get('key');
  const fmt  = (searchParams.get('format') || 'md').toLowerCase(); // md|csv
  if (!key) return NextResponse.json({ error: 'key is required' }, { status: 400 });

  try {
    const user_code = await getUserCode(req);
    const { startUTC, endUTC, label } = toRange(kind, key);

    const { data, error } = await supabase
      .from('daily_checks')
      .select('created_at, habit_name, vision_checked, resonance_checked, mood_text, memo_text')
      .eq('user_code', user_code)
      .gte('created_at', startUTC)
      .lt('created_at', endUTC)
      .order('created_at', { ascending: true });

    if (error) throw error;

    if (fmt === 'csv') {
      const header = '日時(JST),項目,Vision,共鳴,状況・気持ち,ひらめき・日記';
      const lines = (data ?? []).map(r => {
        const jst = new Date(new Date(r.created_at as string).getTime() + 9*3600*1000);
        const ts  = `${jst.getUTCFullYear()}-${String(jst.getUTCMonth()+1).padStart(2,'0')}-${String(jst.getUTCDate()).padStart(2,'0')} ${String(jst.getUTCHours()).padStart(2,'0')}:${String(jst.getUTCMinutes()).padStart(2,'0')}`;
        const row = [
          ts,
          r.habit_name ?? '実践チェック',
          r.vision_checked ? '1' : '',
          r.resonance_checked ? '1' : '',
          (r.mood_text ?? '').replace(/\n/g,'\\n').replace(/"/g,'""'),
          (r.memo_text ?? '').replace(/\n/g,'\\n').replace(/"/g,'""'),
        ].map(v => `"${v}"`).join(',');
        return row;
      });
      const body = [header, ...lines].join('\r\n');
      return new NextResponse(body, {
        status: 200,
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="practice_${kind}_${label}.csv"`,
        },
      });
    } else {
      const lines: string[] = [];
      lines.push(`# 実践日記 エクスポート（${kind === 'day' ? '日' : '月'}: ${label}）`);
      for (const r of data ?? []) {
        const jst = new Date(new Date(r.created_at as string).getTime() + 9*3600*1000);
        const ts  = `${jst.getUTCFullYear()}-${String(jst.getUTCMonth()+1).padStart(2,'0')}-${String(jst.getUTCDate()).padStart(2,'0')} ${String(jst.getUTCHours()).padStart(2,'0')}:${String(jst.getUTCMinutes()).padStart(2,'0')}`;
        lines.push(`\n## ${ts}  ${r.habit_name ?? '実践チェック'}`);
        lines.push(`- Vision: ${r.vision_checked ? '✅' : '—'}  / 共鳴: ${r.resonance_checked ? '✅' : '—'}`);
        if (r.mood_text) lines.push(`- **状況・気持ち**\n\n${r.mood_text}`);
        if (r.memo_text) lines.push(`- **ひらめき・日記**\n\n${r.memo_text}`);
      }
      const body = lines.join('\n');
      return new NextResponse(body, {
        status: 200,
        headers: {
          'Content-Type': 'text/markdown; charset=utf-8',
          'Content-Disposition': `attachment; filename="practice_${kind}_${label}.md"`,
        },
      });
    }
  } catch (e: any) {
    if (e?.message === '401') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    return NextResponse.json({ error: e?.message || 'internal error' }, { status: 500 });
  }
}
