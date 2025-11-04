// src/app/api/qcode/self/comment/route.ts
import { NextResponse } from 'next/server';
import { recordQOnSelfComment } from '@/lib/qcode/self';

export const dynamic = 'force-dynamic';
export const fetchCache = 'default-no-store';

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const user_code = String(body.user_code || '').trim();
    const post_id = String(body.post_id || '').trim();
    const comment_id = String(body.comment_id || '').trim();

    if (!user_code || !post_id || !comment_id) {
      return NextResponse.json(
        { ok: false, error: 'user_code, post_id and comment_id are required' },
        { status: 400 },
      );
    }

    const q_code = await recordQOnSelfComment({ user_code, post_id, comment_id });
    return NextResponse.json({ ok: true, q: q_code.q, q_code });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? 'failed' }, { status: 500 });
  }
}
