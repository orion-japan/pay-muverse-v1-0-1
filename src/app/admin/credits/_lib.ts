// src/app/admin/credits/_lib.ts
import { NextRequest, NextResponse } from 'next/server';
import { verifyFirebaseAndAuthorize } from '@/lib/authz';

export function json(data: any, init?: number | ResponseInit) {
  const status =
    typeof init === 'number' ? init : (init as ResponseInit | undefined)?.['status'] ?? 200;
  const headers = new Headers(
    typeof init === 'number' ? undefined : (init as ResponseInit | undefined)?.headers,
  );
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('Access-Control-Allow-Origin', '*');
  return new NextResponse(JSON.stringify(data), { status, headers });
}

/**
 * Next.js の Route Handler（App Router）は NextRequest を渡してくる。
 * ただし内部実装は Request 互換でもあるので、両対応しておく。
 */
export async function requireAdmin(req: NextRequest | Request) {
  const auth = await verifyFirebaseAndAuthorize(req as NextRequest);
  if (!auth?.ok) throw new Error('unauthorized');
  if (!(auth as any).isSuperAdmin) throw new Error('forbidden');
  return auth;
}
