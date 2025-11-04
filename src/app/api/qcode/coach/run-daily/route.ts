import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supa = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

export async function POST(req: Request) {
  // 簡易トークンチェック（環境変数で共有）
  const auth = req.headers.get('authorization') || '';
  if (!auth.endsWith(process.env.CRON_TOKEN!)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  // 1) 最新化（お好みで）
  await supa.rpc('noop'); // ダミー。必要ならSQL関数で MV REFRESH を呼ぶ
  // 例: DB関数 refresh_mv_q_daily() を用意して supa.rpc('refresh_mv_q_daily')

  // 2) 対象ユーザー抽出（RPC: run_q_advice_targets）
  const { data: targets, error } = await supa.rpc('run_q_advice_targets');
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // 3) 各ユーザーの助言を生成（1日1件UPSERTされる）
  const origin = process.env.APP_ORIGIN!;
  const results = [];
  for (const t of targets as Array<{ user_code: string }>) {
    const r = await fetch(
      `${origin}/api/qcode/coach/advise?user=${encodeURIComponent(t.user_code)}`,
      {
        method: 'POST',
        headers: { Authorization: process.env.CRON_TOKEN! },
      },
    );
    results.push({ user: t.user_code, ok: r.ok });
  }

  return NextResponse.json({ count: results.length, results });
}
