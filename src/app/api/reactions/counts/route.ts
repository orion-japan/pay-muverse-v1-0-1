// /app/api/reactions/counts/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

const ALLOWED = ['like', 'heart', 'smile', 'wow', 'share'] as const;
type Totals = Record<(typeof ALLOWED)[number], number>;
const ZERO: Totals = { like: 0, heart: 0, smile: 0, wow: 0, share: 0 };

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const post_id = searchParams.get('post_id') || '';
  const is_parent = (searchParams.get('is_parent') || 'false') === 'true';

  if (!post_id) {
    return NextResponse.json({ ok: false, message: 'post_id is required', totals: ZERO }, { status: 400 });
  }

  try {
    const totals: Totals = { ...ZERO };
    for (const key of ALLOWED) {
      const { count, error } = await supabase
        .from('reactions')
        .select('*', { head: true, count: 'exact' })
        .eq('post_id', post_id)
        .eq('reaction', key)
        .eq('is_parent', is_parent);

      if (error) console.warn('[counts]', key, error.message);
      totals[key] = count ?? 0;
    }

    return NextResponse.json({ ok: true, post_id, is_parent, totals }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e: any) {
    console.error('[counts] UNEXPECTED', e);
    return NextResponse.json({ ok: false, message: 'Unexpected error', totals: ZERO }, { status: 500 });
  }
}
