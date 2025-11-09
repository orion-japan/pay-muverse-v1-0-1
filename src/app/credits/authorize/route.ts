// src/app/credits/authorize/route.ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { POST as API_POST } from '@/app/api/credits/authorize/route';

export async function POST(req: NextRequest) {
  const res = await API_POST(req);
  const h = new Headers(res.headers);
  h.set('x-handler', 'app/credits/authorize (legacy shim)');
  h.set('x-deprecated', 'true');
  h.set('x-prefer-endpoint', '/api/credits/authorize');
  return new NextResponse(res.body, { status: res.status, headers: h });
}
