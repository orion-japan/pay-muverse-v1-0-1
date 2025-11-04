// src/app/api/agent/mui/case/[seed]/quartet/route.ts
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ seed: string }> }, // ★ Next.js 15: params は Promise
) {
  const { seed } = await ctx.params; // ★ ここで await

  if (!seed) {
    return NextResponse.json({ ok: false, error: 'Missing seed' }, { status: 400 });
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE;

  if (!url || !key) {
    return NextResponse.json(
      { ok: false, error: 'Missing Supabase environment variables' },
      { status: 500 },
    );
  }

  try {
    const res = await fetch(
      `${url}/rest/v1/v_q_case_quartet?seed_id=eq.${encodeURIComponent(seed)}`,
      {
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
        },
        cache: 'no-store',
      },
    );

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return NextResponse.json(
        { ok: false, error: 'Supabase fetch failed', detail },
        { status: res.status },
      );
    }

    const data = await res.json();
    return NextResponse.json({ ok: true, quartet: data?.[0] ?? null });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: 'Internal error', detail: String(e?.message ?? e) },
      { status: 500 },
    );
  }
}
