// src/app/api/qcode/vision/check/evaluate/route.ts
import { NextResponse } from 'next/server';
import { calcVisionCheckQ } from '@/lib/qcode/vision/qcalc';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { fmtJst, jstDayWindow, todayJst } from '@/lib/qcode/vision/utils';

export const dynamic = 'force-dynamic';
export const fetchCache = 'default-no-store';

export async function POST(req: Request) {
  try {
    const b = await req.json().catch(() => ({}));

    // ---- エイリアス吸収（vision_id でも OK / date でも OK）----
    const user_code = String(b.user_code || '').trim();
    const seed_id = String(b.seed_id ?? b.vision_id ?? '').trim();
    const for_date = String(b.for_date ?? b.date ?? todayJst());

    if (!user_code || !seed_id) {
      return NextResponse.json(
        { ok: false, error: 'user_code and vision_id/seed_id are required' },
        { status: 400 },
      );
    }

    // 1) ルール計算で Q を算出
    const q_code = await calcVisionCheckQ(user_code, seed_id, for_date);

    // 2) 制約対応：q_code に currentQ / depthStage を必ず持たせる
    const safe_q_code = {
      ...q_code,
      currentQ: (q_code as any).currentQ ?? (q_code as any).q ?? 'Q?',
      depthStage: (q_code as any).depthStage ?? 'S1', // FIXME: 実データで段階が出せるなら置き換え
    };

    // 3) ログ保存（q_code_logs）
    const row = {
      user_code,
      source_type: 'vision',
      intent: 'vision_check',
      q_code: safe_q_code, // ← 制約を満たす JSONB
      for_date, // 拡張カラム（任意）
      seed_id, // 拡張カラム（任意）
    };

    const { error } = await supabaseAdmin.from('q_code_logs').insert([row]);
    if (error) {
      console.debug('[DEBUG] supabase error:', error);
      throw error;
    }

    // 4) 画面向けの軽いサマリ
    const when = fmtJst(new Date(jstDayWindow(for_date).start));
    const summary = `評価: ${safe_q_code.currentQ}（${(safe_q_code as any).hint ?? ''}）`;

    return NextResponse.json({ ok: true, when, summary, q_code: safe_q_code });
  } catch (e: any) {
    console.debug('[DEBUG] catch error:', e);
    return NextResponse.json({ ok: false, error: e?.message ?? 'failed' }, { status: 500 });
  }
}
