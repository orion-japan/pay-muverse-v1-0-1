// src/app/api/agent/iros/profile/upsert/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { verifyFirebaseAndAuthorize } from '@/lib/authz';
import { upsertProfile } from '@/lib/iros/memory/profile';
import { auditSemProf } from '@/lib/iros/memory/audit';

/** reply ルートと同じ方式で userCode を取る */
function pickUserCode(req: NextRequest, auth: any): string | null {
  const h = req.headers.get('x-user-code');
  const fromHeader = h && h.trim() ? h.trim() : null;
  return (auth?.userCode && String(auth.userCode)) || fromHeader || null;
}

export async function POST(req: NextRequest) {
  try {
    // 1) Firebase / authz チェック
    const auth = await verifyFirebaseAndAuthorize(req);
    if (!auth?.ok) {
      return NextResponse.json(
        { ok: false, error: 'unauthorized' },
        { status: 401 },
      );
    }

    // 2) user_code 抽出（ヘッダ or auth から）
    const user_code = pickUserCode(req, auth);
    if (!user_code) {
      console.warn('[IROS/profile/upsert] user_code not found', auth);
      return NextResponse.json(
        { ok: false, error: 'unauthorized' },
        { status: 401 },
      );
    }

    // 3) body 取得
    const { style, taboos, terms } = await req.json();

    // 4) プロファイル更新
    const id = await upsertProfile({ user_code, style, taboos, terms });

    // 5) 監査ログ（任意）
    await auditSemProf('profile_update', user_code, undefined, 'profile upsert');

    return NextResponse.json({ ok: true, user_code: id });
  } catch (e: any) {
    console.error('[IROS/profile/upsert] fatal', e);
    return NextResponse.json(
      { ok: false, error: String(e?.message || 'error') },
      { status: 500 },
    );
  }
}
