// src/app/api/guard/sofia/route.ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { verifyFirebaseAndAuthorize } from '@/lib/authz';

function isMasterOrAdmin(...vals: Array<string | null | undefined>) {
  for (const v of vals) {
    const s = (v ?? '').toString().toLowerCase();
    if (s === 'master' || s === 'admin') return true;
  }
  return false;
}

export async function GET(req: NextRequest) {
  // あなたの authz 側で：Firebase IDトークン検証 + ユーザーの権限情報を取り出す
  // 期待される返り値の例：
  // { ok: true, status: 200, role?: string, userCode?: string, planStatus?: string, clickType?: string }
  const z = await verifyFirebaseAndAuthorize(req);

  if (!z?.ok) {
    return NextResponse.json(
      { allowed: false, error: z?.error ?? 'unauthorized' },
      { status: z?.status ?? 401 },
    );
  }

  // role / planStatus / clickType のいずれかが master / admin なら許可
  const role = (z as any).role ?? null;
  const planStatus = (z as any).planStatus ?? (z as any).plan_status ?? null;
  const clickType = (z as any).clickType ?? (z as any).click_type ?? null;

  const allowed = isMasterOrAdmin(role, planStatus, clickType);

  return NextResponse.json(
    {
      allowed,
      role,
      planStatus,
      clickType,
      userCode: (z as any).userCode ?? null,
    },
    { status: 200 },
  );
}
