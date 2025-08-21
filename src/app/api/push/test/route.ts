// src/app/api/push/test/route.ts
import { NextResponse } from 'next/server';
import { getWebpush } from '@/lib/webpush';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const pub = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || '';
  const priv = process.env.VAPID_PRIVATE_KEY || '';
  const wp = await getWebpush();

  return NextResponse.json({
    ok: true,
    hasVapidKeys: Boolean(pub && priv),
    pub_present: Boolean(pub),
    priv_present: Boolean(priv),
    pub_len: pub.length,
    priv_len: priv.length,
    configured: Boolean(wp),
    note: (!pub || !priv)
      ? 'One or both env vars are missing on server runtime.'
      : 'web-push configured if configured=true',
  });
}
