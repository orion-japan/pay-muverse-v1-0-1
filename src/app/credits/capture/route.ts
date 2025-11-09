// src/app/credits/capture/route.ts
import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const url = new URL(req.url);
  url.pathname = '/api/credits/capture';
  const h = new Headers();
  h.set('x-handler', 'app/credits/capture (legacy redirect)');
  h.set('x-deprecated', 'true');
  h.set('x-prefer-endpoint', '/api/credits/capture');
  return NextResponse.redirect(url.toString(), { status: 307, headers: h });
}
