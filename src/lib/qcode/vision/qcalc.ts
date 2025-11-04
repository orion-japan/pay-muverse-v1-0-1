// src/lib/vision/qcalc.ts
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { jstDayWindow, todayJst } from './utils';

type Q = 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5';
const QCOLORS: Record<Q, string> = {
  Q1: '#E0F2FE',
  Q2: '#DCFCE7',
  Q3: '#FEF3C7',
  Q4: '#FEE2E2',
  Q5: '#EDE9FE',
};

function smallJitter<QT extends Q>(q: QT): Q {
  if (Math.random() > 0.12) return q;
  const ring: Q[] = ['Q1', 'Q2', 'Q3', 'Q4']; // 近傍だけ
  const i = ring.indexOf(q);
  if (i < 0) return q;
  return ring[Math.max(0, Math.min(ring.length - 1, i + (Math.random() < 0.5 ? -1 : 1)))] as Q;
}

/**
 * Visionの1日評価（JST）: 連続チェック・空白日・その日の証拠有無でQを決定
 * 必要テーブル:
 *  - seeds(id, user_code, title, meta jsonb)
 *  - seed_checks(id, seed_id, user_code, created_at, done boolean, meta jsonb)
 *  - seed_evidences(id, seed_id, user_code, created_at, meta jsonb) // 画像/数値など
 */
export async function calcVisionCheckQ(user_code: string, seed_id: string, forDate?: string) {
  const day = forDate || todayJst();
  const { start, end } = jstDayWindow(day);

  // その日分
  const [checksToday, evidToday] = await Promise.all([
    supabaseAdmin
      .from('seed_checks')
      .select('id, done, created_at')
      .eq('user_code', user_code)
      .eq('seed_id', seed_id)
      .gte('created_at', start)
      .lt('created_at', end),
    supabaseAdmin
      .from('seed_evidences')
      .select('id, created_at')
      .eq('user_code', user_code)
      .eq('seed_id', seed_id)
      .gte('created_at', start)
      .lt('created_at', end),
  ]);

  const doneToday = (checksToday.data ?? []).some((r) => r.done);
  const hasEvidenceToday = (evidToday.data ?? []).length > 0;

  // 直近14日ぶんのチェック日
  const since14Start = jstDayWindow(
    new Date(Date.now() + 9 * 3600 * 1000 - 13 * 86400000).toISOString().slice(0, 10),
  ).start;
  const { data: recentChecks } = await supabaseAdmin
    .from('seed_checks')
    .select('created_at, done')
    .eq('user_code', user_code)
    .eq('seed_id', seed_id)
    .gte('created_at', since14Start)
    .order('created_at', { ascending: false });

  const daySet = new Set<string>();
  for (const r of recentChecks ?? []) {
    if (!r.done) continue;
    const d = new Date(r.created_at);
    const key = d.toISOString().slice(0, 10);
    daySet.add(key);
  }

  // streak（連続日数）と前回からの空白
  let streak = 0;
  {
    for (let i = 0; i < 14; i++) {
      const d = new Date(Date.now() + 9 * 3600 * 1000);
      d.setUTCDate(d.getUTCDate() - i);
      const key = d.toISOString().slice(0, 10);
      if (daySet.has(key)) streak++;
      else break;
    }
  }
  // gap（直近Done日からの空白日数）
  let gapDays = 0;
  {
    // 今日を含め遡って最初に見つかる「やっていない日」数
    const cur = new Date(Date.now() + 9 * 3600 * 1000);
    while (gapDays < 30) {
      const key = cur.toISOString().slice(0, 10);
      if (daySet.has(key)) break;
      gapDays++;
      cur.setUTCDate(cur.getUTCDate() - 1);
    }
  }

  // ===== Qロジック =====
  let q: Q,
    hint = '',
    confidence = 0.6;
  if (doneToday) {
    if (streak >= 5 && hasEvidenceToday) {
      q = 'Q2';
      hint = '継続+証拠あり';
      confidence = 0.75;
    } else if (streak >= 2) {
      q = 'Q1';
      hint = '継続中';
      confidence = 0.68;
    } else {
      q = 'Q3';
      hint = '始動したばかり';
      confidence = 0.6;
    }
  } else {
    if (gapDays >= 5) {
      q = Math.random() < 0.6 ? 'Q3' : 'Q4';
      hint = '空白が続く';
      confidence = 0.7;
    } else if (gapDays >= 2) {
      q = 'Q3';
      hint = 'やや停滞';
      confidence = 0.62;
    } else {
      q = 'Q1';
      hint = '様子見';
      confidence = 0.58;
    }
  }
  q = smallJitter(q);

  const meta = {
    source: 'vision',
    kind: 'check',
    seed_id,
    for_date: day,
    done_today: doneToday,
    evidence_today: hasEvidenceToday,
    streak_14d: streak,
    gap_days: gapDays,
  };

  return {
    q,
    confidence,
    hint,
    color_hex: QCOLORS[q],
    version: 'qmap.v0.3.2',
    by: 'sofia',
    meta,
  };
}
