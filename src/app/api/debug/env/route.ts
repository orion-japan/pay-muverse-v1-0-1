export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';

export async function GET() {
  // ここでは中身は返さない。存在と長さ・トリム後の有無だけ確認
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const sr = process.env.SUPABASE_SERVICE_ROLE?.trim();
  const jwt = process.env.SUPABASE_JWT_SECRET?.trim();

  return NextResponse.json({
    hasUrl: !!url,
    hasServiceRole: !!sr,
    hasJwtSecret: !!jwt,
    urlHost: url ? new URL(url).host : null,
    serviceRoleLooksLikeJwt: !!sr && sr.startsWith('eyJ'), // JWTっぽいか
    note: '全て true になっている必要があります',
  });
}
