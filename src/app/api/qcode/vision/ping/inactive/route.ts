// src/app/api/qcode/vision/ping/inactive/route.ts
import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { jstDayWindow } from '@/lib/qcode/vision/utils';

export const dynamic = 'force-dynamic';
export const fetchCache = 'default-no-store';

/** 入力: { user_code, days?: number } 既定: 3日 */
export async function POST(req: Request) {
  try {
    const b = await req.json().catch(() => ({}));
    const user_code = String(b.user_code || '').trim();
    const days = Math.max(1, Math.min(30, Number(b.days ?? 3)));
    if (!user_code) {
      return NextResponse.json({ ok: false, error: 'user_code required' }, { status: 400 });
    }

    // 対象 seeds
    const { data: seeds, error: eSeeds } = await supabaseAdmin
      .from('seeds')
      .select('id, title')
      .eq('user_code', user_code);

    if (eSeeds) throw eSeeds;

    const seedMap = new Map<string, { id: string; title: string }>();
    for (const s of seeds ?? []) seedMap.set(String(s.id), { id: String(s.id), title: s.title });

    if (!seedMap.size) {
      return NextResponse.json({
        ok: true,
        sleepy: [],
        message: '種（ゴール）がまだ登録されていません。',
      });
    }

    // JST 今日 00:00 を基準に days 日前の 00:00 をカットオフ
    const todayKey = new Date().toISOString().slice(0, 10);
    const todayWin = jstDayWindow(todayKey);
    const cutoffMs = new Date(todayWin.start).getTime() - days * 86400000;
    const cutoffIso = new Date(cutoffMs).toISOString();

    // 各 seed の最終チェック日時を1クエリで取得
    // Postgresなら: SELECT seed_id, max(created_at) AS last_created_at FROM seed_checks WHERE user_code = $1 GROUP BY seed_id
    const { data: lastChecks, error: eChecks } = await supabaseAdmin
      .from('seed_checks')
      .select('seed_id, created_at')
      .eq('user_code', user_code)
      .order('created_at', { ascending: false });

    if (eChecks) throw eChecks;

    const lastBySeed = new Map<string, string>();
    for (const r of lastChecks ?? []) {
      const sid = String(r.seed_id);
      if (!lastBySeed.has(sid)) {
        lastBySeed.set(sid, r.created_at); // 最初(=最新)だけ保持
      }
    }

    const sleepy: Array<{ seed_id: string; title: string; last_check?: string | null }> = [];
    for (const { id, title } of seedMap.values()) {
      const last = lastBySeed.get(id) || null;
      const inactive = !last || new Date(last) < new Date(cutoffIso);
      if (inactive) {
        sleepy.push({ seed_id: id, title, last_check: last });
      }
    }

    return NextResponse.json({
      ok: true,
      cutoff: cutoffIso, // デバッグ用
      sleepy,
      message: sleepy.length
        ? '最近止まっている目標があります。軽く様子を聞きにいきましょうか？'
        : 'すべて順調です！',
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? 'failed' }, { status: 500 });
  }
}
