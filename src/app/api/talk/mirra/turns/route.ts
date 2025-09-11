// src/app/api/mirra/turns/route.ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import {
  verifyFirebaseAndAuthorize,
  SUPABASE_URL,
  SERVICE_ROLE,
} from '@/lib/authz';

function sb() {
  return createClient(SUPABASE_URL!, SERVICE_ROLE!, { auth: { persistSession: false } });
}

export async function GET(req: Request) {
  const z = await verifyFirebaseAndAuthorize(req as any);
  if (!z.ok) return NextResponse.json({ error: z.error }, { status: z.status });
  if (!z.allowed) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  const url = new URL(req.url);
  const convId = url.searchParams.get('conv_id');
  if (!convId) return NextResponse.json({ error: 'missing conv_id' }, { status: 400 });

  const s = sb();

  // 自分のスレッドか軽く検証（任意）
  const { data: th } = await s
    .from('talk_threads')
    .select('id')
    .eq('id', convId)
    .eq('agent', 'mirra')
    .eq('created_by', z.userCode)
    .maybeSingle();

  if (!th) return NextResponse.json({ items: [] }, { status: 200 });

  const { data, error } = await s
    .from('talk_messages')
    .select('id, role, content, meta, created_at')
    .eq('thread_id', convId)
    .order('created_at', { ascending: true });

  if (error) return NextResponse.json({ error: String(error.message || error) }, { status: 500 });

  return NextResponse.json({
    items: (data ?? []).map((row) => ({
      id: row.id,
      role: row.role,
      content: row.content,
      meta: row.meta ?? null,
      created_at: row.created_at,
    })),
  });
}
