// src/app/api/vision-criteria/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const runtime = 'nodejs'; // Supabase/Node API 想定

// --- Supabase 初期化 ---
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.supabaseKey!
);

/**
 * 期待するクエリ:
 *   - vision_id: string（任意。指定があれば vision_criteria から criteria を取得）
 *   - ids: comma-separated string（任意。vision_id が無い場合はこちらを使用）
 *   - status: 'done' など（任意。デフォルト 'done'）
 *
 * レスポンス:
 *   {
 *     criteria: Array<{
 *       criteria_id: string;
 *       title?: string | null;
 *       description?: string | null;
 *       weight?: number | null;
 *       done_count: number; // status一致のチェック件数
 *     }>
 *   }
 */
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const visionId = searchParams.get('vision_id');
    const status = searchParams.get('status') || 'done';

    // ids の受け口（vision_id が無いときに使用）
    const idsParam = searchParams.get('ids');

    // 1) criteria の母集団を決める
    type CriteriaRow = {
      id: string;
      title?: string | null;
      description?: string | null;
      weight?: number | null;
    };

    let criteriaRows: CriteriaRow[] = [];
    if (visionId) {
      // vision_id から criteria を取得（必要カラムのみ）
      const { data, error } = await supabase
        .from('vision_criteria')
        .select('id, title, description, weight')
        .eq('vision_id', visionId)
        .order('id', { ascending: true });

      if (error) throw error;
      criteriaRows = data ?? [];
    } else if (idsParam) {
      // ids= "a,b,c" のように直接指定された場合
      const ids = idsParam
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

      if (ids.length) {
        const { data, error } = await supabase
          .from('vision_criteria')
          .select('id, title, description, weight')
          .in('id', ids)
          .order('id', { ascending: true });

        if (error) throw error;
        criteriaRows = data ?? [];
      }
    } else {
      // どちらも無ければ 400
      return NextResponse.json(
        { error: 'vision_id または ids を指定してください' },
        { status: 400 }
      );
    }

    const ids = criteriaRows.map((c) => c.id);
    if (!ids.length) {
      // 空なら空の配列返す
      return NextResponse.json({ criteria: [] });
    }

    // 2) 旧 `.group("criteria_id")` 相当の集計
    //    supabase-js に group は無いので、JS 側で reduce 集計する
    type CheckRow = { criteria_id: string };

    const { data: doneRows, error: doneErr } = await supabase
      .from('vision_criteria_checks')
      .select('criteria_id')
      .eq('status', status)
      .in('criteria_id', ids)
      .returns<CheckRow[]>();

    if (doneErr) throw doneErr;

    const doneCountMap = new Map<string, number>();
    for (const r of doneRows ?? []) {
      doneCountMap.set(r.criteria_id, (doneCountMap.get(r.criteria_id) ?? 0) + 1);
    }

    // 3) レスポンス整形（元の構造を崩さない）
    const criteria = criteriaRows.map((row) => ({
      criteria_id: row.id,
      title: row.title ?? null,
      description: row.description ?? null,
      weight: row.weight ?? null,
      done_count: doneCountMap.get(row.id) ?? 0,
    }));

    return NextResponse.json({ criteria });
  } catch (err: any) {
    console.error('⨯ /api/vision-criteria GET error:', err);
    return NextResponse.json(
      { error: 'failed to fetch vision criteria', detail: String(err) },
      { status: 500 }
    );
  }
}

/**
 * 必要なら POST など他メソッドもここに追加できますが、
 * 今回のビルドエラーは GET 内の `.group("criteria_id")` を
 * JS 集計に置き換えることで解消しています。
 */
