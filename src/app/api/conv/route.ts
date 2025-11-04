// src/app/api/conv/route.ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { verifyFirebaseAndAuthorize } from '@/lib/authz';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

// sofia_conversations に合わせる
type Row = { conversation_code: string; title: string | null; updated_at: string | null };

export async function GET(req: NextRequest) {
  try {
    const z = await verifyFirebaseAndAuthorize(req);
    if (!z.ok || !z.userCode) {
      return NextResponse.json({ error: z.error ?? 'unauthorized' }, { status: z.status ?? 401 });
    }

    const sb = createClient(URL, KEY, { auth: { persistSession: false } });

    const { data, error } = await sb
      .from('sofia_conversations')
      .select('conversation_code, title, updated_at')
      .eq('user_code', z.userCode)
      .order('updated_at', { ascending: false })
      .limit(50);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const rows = (data ?? []) as Row[];
    return NextResponse.json({
      items: rows.map((r) => ({
        id: r.conversation_code,
        title: r.title ?? '無題のセッション',
        updated_at: r.updated_at ?? null,
      })),
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? 'internal error' }, { status: 500 });
  }
}
