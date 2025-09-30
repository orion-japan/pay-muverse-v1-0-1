// src/app/api/qcode/self/reaction/route.ts
import { NextResponse } from 'next/server';
import { recordQOnSelfReaction } from '@/lib/qcode/self';

export const dynamic = 'force-dynamic';
export const fetchCache = 'default-no-store';

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const user_code = String(body.user_code || '').trim();
    const post_id = String(body.post_id || '').trim();
    const reaction = String(body.reaction || '').trim(); // 例: "👍" / "heart" / "angry"

    if (!user_code || !post_id || !reaction) {
      return NextResponse.json(
        { ok: false, error: 'user_code, post_id and reaction are required' },
        { status: 400 }
      );
    }

    const q_code = await recordQOnSelfReaction({ user_code, post_id, reaction });
    return NextResponse.json({ ok: true, q: q_code.q, q_code });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? 'failed' }, { status: 500 });
  }
}
