// src/app/api/agent/muai/turns/route.ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createClient } from '@supabase/supabase-js';
import {
  verifyFirebaseAndAuthorize,
  SUPABASE_URL,
  SERVICE_ROLE,
} from '@/lib/authz';

function sb() {
  return createClient(SUPABASE_URL!, SERVICE_ROLE!, {
    auth: { persistSession: false },
  });
}

export async function GET(req: Request) {
  // 🔑 Firebase 認可チェック
  const z = await verifyFirebaseAndAuthorize(req as any);
  if (!z.ok) return NextResponse.json({ error: z.error }, { status: z.status });
  if (!z.allowed) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  // conv_id を Cookie またはクエリから取得
  const store = await cookies();
  const url = new URL(req.url);
  const convId = store.get('conv_id')?.value ?? url.searchParams.get('conv_id');
  if (!convId) {
    return NextResponse.json({ error: 'missing conversation id' }, { status: 400 });
  }

  const s = sb();

  // ✅ mu_turns から履歴を取得
  const { data, error } = await s
    .from('mu_turns')
    .select('id, role, content, used_credits, created_at')
    .eq('conv_id', convId)
    .order('created_at', { ascending: true });

  if (error) {
    return NextResponse.json({ error: String(error.message || error) }, { status: 500 });
  }

  // UI にそのまま渡せる形式に揃える
  return NextResponse.json({
    items: (data ?? []).map((row) => ({
      id: row.id,
      role: row.role,
      content: row.content,
      used_credits: row.used_credits,
      created_at: row.created_at,
    })),
  });
}
