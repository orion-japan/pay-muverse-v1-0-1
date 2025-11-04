// src/app/api/qcode/vision/seed/structure/route.ts
import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { todayJst } from '@/lib/qcode/vision/utils';

export const dynamic = 'force-dynamic';
export const fetchCache = 'default-no-store';

/**
 * 入力 (aliases):
 *  { user_code, seed_id|vision_id, title?, note?, lanes?, cadence?, metric?, why?, deadline?, min_actions? }
 * metric 例: { type:'number'|'count'|'time', unit?:'cm'|'min'|'回', baseline?:number, target?:number }
 * lanes  例: ['morning','evening'] など（string[]）
 * cadence例: 'daily' | 'weekly' | 'custom'
 */
export async function POST(req: Request) {
  try {
    const b = await req.json().catch(() => ({}));
    const user_code = String(b.user_code || '').trim();
    const seed_id = String(b.seed_id ?? b.vision_id ?? '').trim();
    if (!user_code || !seed_id) {
      return NextResponse.json(
        { ok: false, error: 'user_code and seed_id/vision_id are required' },
        { status: 400 },
      );
    }

    // 既存 seed
    const { data: seedRow, error: e1 } = await supabaseAdmin
      .from('seeds')
      .select('id, title, meta')
      .eq('id', seed_id)
      .eq('user_code', user_code)
      .single();

    if (e1 || !seedRow) {
      return NextResponse.json({ ok: false, error: 'seed not found' }, { status: 404 });
    }

    // 入力ノーマライズ
    const title = String(b.title ?? seedRow.title ?? '').trim();

    // lanes
    const lanesRaw = Array.isArray(b.lanes)
      ? b.lanes
      : typeof b.lanes === 'string'
        ? [b.lanes]
        : [];
    const lanes = lanesRaw
      .filter((x: any) => typeof x === 'string' && x.trim())
      .map((s: string) => s.trim());
    const cadenceAllow = new Set(['daily', 'weekly', 'custom']);
    const cadence = cadenceAllow.has(String(b.cadence)) ? String(b.cadence) : 'daily';

    // metric
    const metric = ((): any | null => {
      if (!b.metric || typeof b.metric !== 'object') return null;
      const t = String(b.metric.type || '').trim();
      if (!['number', 'count', 'time'].includes(t)) return null;
      const unit = typeof b.metric.unit === 'string' ? b.metric.unit : undefined;
      const baseline = Number.isFinite(Number(b.metric.baseline))
        ? Number(b.metric.baseline)
        : undefined;
      const target = Number.isFinite(Number(b.metric.target)) ? Number(b.metric.target) : undefined;
      return {
        type: t,
        ...(unit ? { unit } : {}),
        ...(baseline !== undefined ? { baseline } : {}),
        ...(target !== undefined ? { target } : {}),
      };
    })();

    const min_actions = Array.isArray(b.min_actions)
      ? b.min_actions.filter((x: any) => typeof x === 'string' && x.trim())
      : [];

    const ai = {
      goal_struct: {
        what: title || 'マイゴール',
        why: b.why ?? null,
        deadline: b.deadline ?? null,
      },
      metric: metric,
      cadence,
      lanes: lanes.length ? lanes : ['daily'],
      min_actions,
      created_on: todayJst(),
    };

    // 既存 meta と安全マージ（JSONB前提）
    const metaOld = seedRow.meta && typeof seedRow.meta === 'object' ? seedRow.meta : {};
    const meta = { ...metaOld, ai }; // ai ブランチを入れ替え

    const { error: e2 } = await supabaseAdmin
      .from('seeds')
      .update({ meta })
      .eq('id', seed_id)
      .eq('user_code', user_code);

    if (e2) throw e2;

    return NextResponse.json({ ok: true, seed_id, ai, saved_meta: meta });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? 'failed' }, { status: 500 });
  }
}
