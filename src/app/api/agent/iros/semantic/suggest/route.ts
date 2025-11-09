// src/app/api/iros/semantic/suggest/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { verifyFirebaseAndAuthorize, normalizeAuthz } from '@/lib/authz';
import { suggestSemanticDef } from '@/lib/iros/memory/semantic';
import { auditSemProf } from '@/lib/iros/memory/audit';

export async function POST(req: NextRequest) {
  try {
    const raw = await verifyFirebaseAndAuthorize(req);
    const a = normalizeAuthz(raw) as any;
    const user_code = String(a.userCode || a.user_code || a.uid || a.sub || '');
    if (!user_code) return NextResponse.json({ ok:false, error:'unauthorized' }, { status:401 });

    const { key, definition, aliases } = await req.json();
    if (!key || !definition) return NextResponse.json({ ok:false, error:'INVALID' }, { status:400 });

    const id = await suggestSemanticDef({ key, definition, aliases, user_code });
    await auditSemProf('semantic_suggest', user_code, id, `key=${key}`);
    return NextResponse.json({ ok:true, id });
  } catch (e:any) {
    return NextResponse.json({ ok:false, error:String(e.message||'error') }, { status:500 });
  }
}
