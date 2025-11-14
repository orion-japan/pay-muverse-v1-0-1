// src/app/api/debug/authz/route.ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { verifyFirebaseAndAuthorize } from '@/lib/authz';

/** JWT のペイロードだけ簡易デコード（署名検証なし・debug用途） */
function decodeJwtPayload(authzHeader?: string | null) {
  try {
    if (!authzHeader) return null;
    const m = /^Bearer\s+(.+)$/.exec(authzHeader.trim());
    if (!m) return null;
    const token = m[1];
    const parts = token.split('.');
    if (parts.length < 2) return null;
    const payload = parts[1];
    const pad = payload.length % 4 === 2 ? '==' : payload.length % 4 === 3 ? '=' : '';
    const json = Buffer.from(payload + pad, 'base64').toString('utf8');
    return JSON.parse(json);
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  const authz = await verifyFirebaseAndAuthorize(req);

  // x-user-code をそのままエコー（互換のため）
  const xUserCode =
    req.headers.get('x-user-code') ||
    req.headers.get('X-User-Code') ||
    null;

  // 署名検証は authz.ts に任せ、ここでは debug のために payload を素読み
  const rawPayload = decodeJwtPayload(
    req.headers.get('authorization') || req.headers.get('Authorization'),
  );

  const echo = {
    claim_role: rawPayload?.role ?? null,
    claim_user_code: rawPayload?.user_code ?? null,
    provider: rawPayload?.firebase?.sign_in_provider ?? null,
    token_uid: rawPayload?.uid ?? null,
  };

  return NextResponse.json({
    ok: authz.ok,
    status: authz.status,
    allowed: authz.allowed,
    role: authz.role,
    user: authz.user ?? null,
    userCode: authz.userCode ?? null,
    uid: authz.uid ?? null,
    x_user_code: xUserCode,
    echo,
    error: authz.error ?? null,
  });
}

export async function POST(req: NextRequest) {
  // GET と同じ応答（curl -X POST でも確認できるように）
  return GET(req);
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'Content-Type, Authorization, X-User-Code',
    },
  });
}
