export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';

import { verifyFirebaseAndAuthorize, normalizeAuthz } from '@/lib/authz';
import { recordUserJourneyEvent } from '@/lib/userJourney';

export async function POST(req: NextRequest) {
  const authz = await verifyFirebaseAndAuthorize(req);
  const { user, error } = normalizeAuthz(authz);

  if (!user) {
    return NextResponse.json({ ok: false, error: error ?? 'Unauthorized' }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const name = String(body?.name ?? '').trim();

  if (!name) {
    return NextResponse.json({ ok: false, error: 'missing name' }, { status: 400 });
  }

  const result = await recordUserJourneyEvent({
    userCode: user.user_code,
    eventName: name,
    source: body?.source ?? 'app',
    pagePath: body?.pagePath ?? null,
    campaign: body?.campaign ?? null,
    metadata: body?.metadata && typeof body.metadata === 'object' ? body.metadata : {},
  });

  return NextResponse.json(result, { status: result.ok ? 200 : 500 });
}
