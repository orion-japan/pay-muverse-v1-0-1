// src/app/api/iros/profile/upsert/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { verifyFirebaseAndAuthorize, normalizeAuthz } from '@/lib/authz';
import { upsertProfile } from '@/lib/iros/memory/profile';
import { auditSemProf } from '@/lib/iros/memory/audit';

export async function POST(req: NextRequest) {
  try {
    const raw = await verifyFirebaseAndAuthorize(req);
    const a = normalizeAuthz(raw) as any;
    const user_code = String(a.userCode || a.user_code || a.uid || a.sub || '');
    if (!user_code) return NextResponse.json({ ok:false, error:'unauthorized' }, { status:401 });

    const { style, taboos, terms } = await req.json();
    const id = await upsertProfile({ user_code, style, taboos, terms });
    await auditSemProf('profile_update', user_code, undefined, 'profile upsert');
    return NextResponse.json({ ok:true, user_code: id });
  } catch (e:any) {
    return NextResponse.json({ ok:false, error:String(e.message||'error') }, { status:500 });
  }
}
