// src/app/api/dev/qtest/route.ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { verifyFirebaseAndAuthorize } from '@/lib/authz';
import { buildSystemPrompt } from '@/lib/applyQ';

export async function POST(req: NextRequest) {
  try {
    const auth = await verifyFirebaseAndAuthorize(req);
    if (!auth.ok || !auth.userCode) {
      return NextResponse.json({ ok: false, error: auth.error ?? 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const text = String(body.text ?? 'Hello');
    const factual = Boolean(body.factual ?? false);

    const baseSystem =
      'You are Iros. Facts must never be altered. Tone/ordering may be adjusted if hinted.';
    const system = await buildSystemPrompt(baseSystem, auth.userCode, { factual });

    return NextResponse.json({
      ok: true,
      user_code: auth.userCode,
      system,
      sample_messages: [
        { role: 'system', content: system },
        { role: 'user', content: text },
      ],
    });
  } catch (e: any) {
    // 500 の本文でスタック/原因を返す（開発用）
    return NextResponse.json(
      { ok: false, error: String(e?.message ?? e), stack: e?.stack ?? null },
      { status: 500 },
    );
  }
}
