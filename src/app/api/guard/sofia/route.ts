export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { verifyFirebaseAndAuthorize } from '@/lib/authz';

export async function GET(req: NextRequest) {
  const z = await verifyFirebaseAndAuthorize(req);
  if (!z.ok) {
    return NextResponse.json({ allowed: false, error: z.error }, { status: z.status });
  }
  return NextResponse.json({ allowed: true, role: z.role, userCode: z.userCode });
}
