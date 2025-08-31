// src/app/api/conv/route.ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { verifyFirebaseAndAuthorize } from '@/lib/authz';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

export async function GET(req: NextRequest) {
  const z = await verifyFirebaseAndAuthorize(req);
  if (!z.ok || !z.userCode) {
    return NextResponse.json({ error: z.error }, { status: z.status });
  }

  const sb = createClient(URL, KEY, { auth: { persistSession: false } });

  // DBカラムは conversation_code を ID として採用
  const { data, error } = await sb
    .from('conversations')
    .select('conversation_code, title, updated_at')
    .eq('user_code', z.userCode)
    .order('updated_at', { ascending: false })
    .limit(50);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    items: (data ?? []).map(r => ({
      id: r.conversation_code,
      title: r.title,
      updated_at: r.updated_at,
    })),
  });
}
