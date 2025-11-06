// /src/app/api/agent/iros/retitle/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { generateConversationTitle, shouldRetitle } from '@/lib/iros/title';
import { verifyFirebaseAndAuthorize, SUPABASE_URL, SERVICE_ROLE } from '@/lib/authz';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const authz = await verifyFirebaseAndAuthorize(req);
    if (!authz.ok) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });

    const { conversationId, firstUserText, currentTitle } = await req.json();

    if (!conversationId || !firstUserText) {
      return NextResponse.json({ ok: false, error: 'missing params' }, { status: 400 });
    }

    const title = generateConversationTitle(firstUserText);
    const need = shouldRetitle(currentTitle);

    if (!need) {
      return NextResponse.json({ ok: true, title: currentTitle, updated: false });
    }

    const supa = createClient(SUPABASE_URL, SERVICE_ROLE);
    const { error } = await supa
      .from('iros_conversations')
      .update({ title, updated_at: new Date().toISOString() })
      .eq('id', conversationId)
      .limit(1);

    if (error) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }

    return NextResponse.json({ ok: true, title, updated: true });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: String(e?.message || e) }, { status: 500 });
  }
}
