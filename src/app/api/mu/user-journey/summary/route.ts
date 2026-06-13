export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';

import { signQuery } from '@/lib/signed';
import { getUserJourneySummary } from '@/lib/userJourney';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type',
};

function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status, headers: CORS });
}

function verifySignedQuery(userCode: string, ts: string, sig: string) {
  const secret = process.env.MU_SHARED_ACCESS_SECRET || '';
  if (!secret) return false;

  const sec = Number(ts);
  if (!Number.isFinite(sec)) return false;

  const ageSec = Math.abs(Math.floor(Date.now() / 1000) - sec);
  if (ageSec > 60 * 30) return false;

  const expected = signQuery(`ts=${ts}&user_code=${userCode}`, secret);
  return expected === sig;
}

export async function OPTIONS() {
  return new NextResponse('ok', { headers: CORS });
}

export async function GET(req: NextRequest) {
  const sp = new URL(req.url).searchParams;
  const userCode = sp.get('user') || sp.get('user_code') || '';
  const ts = sp.get('ts') || '';
  const sig = sp.get('sig') || '';

  if (!userCode || !ts || !sig || !verifySignedQuery(userCode, ts, sig)) {
    return json({ ok: false, error: 'INVALID_SIGNATURE' }, 401);
  }

  const summary = await getUserJourneySummary(userCode);
  return json({ ok: true, user_code: userCode, summary });
}
