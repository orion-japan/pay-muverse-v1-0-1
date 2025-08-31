export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { verifyFirebaseAndAuthorize, SUPABASE_URL, SERVICE_ROLE } from '@/lib/authz';

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const body = await req.json().catch(() => ({}));
  const { role = 'user', content, meta = {} } = body ?? {};
  if (!content || typeof content !== 'string') {
    return NextResponse.json({ error: 'content required' }, { status: 400 });
  }

  const z = await verifyFirebaseAndAuthorize(req);
  if (!z.ok || !z.pgJwt || !z.userCode) {
    return NextResponse.json({ error: z.error }, { status: z.status });
  }

  const sb = createClient(SUPABASE_URL, SERVICE_ROLE, {
    global: { headers: { Authorization: `Bearer ${z.pgJwt}` } },
    auth: { persistSession: false },
  });

  const { error: e1 } = await sb.from('messages').insert({
    conversation_id: params.id,
    user_code: z.userCode,
    role: role === 'assistant' ? 'assistant' : 'user',
    content,
    meta,
  });
  if (e1) return NextResponse.json({ error: e1.message }, { status: 500 });

  const { error: e2 } = await sb
    .from('conversations')
    .update({ updated_at: new Date().toISOString() })
    .eq('id', params.id);
  if (e2) return NextResponse.json({ error: e2.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
