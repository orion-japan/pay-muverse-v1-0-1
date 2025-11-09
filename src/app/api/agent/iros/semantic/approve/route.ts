// src/app/api/iros/semantic/approve/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { verifyFirebaseAndAuthorize, normalizeAuthz } from '@/lib/authz';
import { approveSemanticDef } from '@/lib/iros/memory/semantic';
import { auditSemProf } from '@/lib/iros/memory/audit';

export async function POST(req: NextRequest) {
  try {
    const raw = await verifyFirebaseAndAuthorize(req);
    const a = normalizeAuthz(raw) as any;
    const user_code = String(a.userCode || a.user_code || a.uid || a.sub || '');
    if (!user_code) return NextResponse.json({ ok:false, error:'unauthorized' }, { status:401 });

    const { id } = await req.json();
    if (!id) return NextResponse.json({ ok:false, error:'INVALID' }, { status:400 });

    const okId = await approveSemanticDef(id, user_code);
    await auditSemProf('semantic_approve', user_code, okId);
    return NextResponse.json({ ok:true, id: okId });
  } catch (e:any) {
    return NextResponse.json({ ok:false, error:String(e.message||'error') }, { status:500 });
  }
}
