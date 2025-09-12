// src/app/api/mtalk/mirra/list/route.ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { verifyFirebaseAndAuthorize, SUPABASE_URL, SERVICE_ROLE } from '@/lib/authz';

function sb() {
  return createClient(SUPABASE_URL!, SERVICE_ROLE!, {
    auth: { persistSession: false },
  });
}

// 直近の会話一覧（ユーザー分）
export async function GET(req: NextRequest) {
  const z = await verifyFirebaseAndAuthorize(req as any);
  if (!z.ok) return NextResponse.json({ error: z.error }, { status: z.status });
  if (!z.allowed) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  const s = sb();
  const { data, error } = await s.from('talk_threads')
    .select('id,title,last_message_at,updated_at')
    .eq('user_a_code', z.userCode)
    .eq('agent', 'mirra')
    .order('last_message_at', { ascending: false })
    .limit(50);

  if (error) {
    return NextResponse.json({ items: [], error: error.message }, { status: 200 });
  }

  return NextResponse.json({
    items: (data ?? []).map(r => ({
      id: r.id,
      title: r.title ?? 'mirra 会話',
      updated_at: r.last_message_at ?? r.updated_at ?? null,
    })),
  });
}
