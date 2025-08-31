export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { verifyFirebaseAndAuthorize, SUPABASE_URL, SERVICE_ROLE } from '@/lib/authz';

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const z = await verifyFirebaseAndAuthorize(req);
  if (!z.ok || !z.pgJwt) {
    return NextResponse.json({ error: z.error }, { status: z.status });
  }

  const sb = createClient(SUPABASE_URL, SERVICE_ROLE, {
    global: { headers: { Authorization: `Bearer ${z.pgJwt}` } },
    auth: { persistSession: false },
  });

  const { error } = await sb.from('conversations').delete().eq('id', params.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
