// src/app/api/mu/list/route.ts
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
  return createClient(SUPABASE_URL!, SERVICE_ROLE!, {
    auth: { persistSession: false },
  });
}

const log = (...args: any[]) => console.log('[mu.list]', ...args);
const err = (...args: any[]) => console.error('[mu.list]', ...args);

export async function GET(req: Request) {
  // 認可チェック
  const z = await verifyFirebaseAndAuthorize(req as any);
  if (!z.ok) return NextResponse.json({ error: z.error }, { status: z.status });
  if (!z.allowed) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  const url = new URL(req.url);
  const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit') ?? 50), 200));

  const s = sb();

  console.time('[mu.list] query');
  log('user', z.userCode, 'limit', limit);

  // ✅ 新しい mu_conversations を参照
  const { data, error } = await s
    .from('mu_conversations')
    .select('id, title, updated_at, last_turn_at')
    .eq('user_code', z.userCode)
    .order('last_turn_at', { ascending: false })
    .limit(limit);

  console.timeEnd('[mu.list] query');

  if (error) {
    err('supabase error:', error);
    return NextResponse.json(
      { items: [], error: String(error.message || error) },
      {
        status: 200,
        headers: { 'x-mu-list-error': String(error.message || error) },
      }
    );
  }

  // 整形して返す（UI が期待する形式に揃える）
  const items = (data ?? []).map((row) => ({
    id: row.id,
    title: row.title ?? 'Mu 会話',
    updated_at: row.last_turn_at ?? row.updated_at ?? null,
  }));

  log('user', z.userCode, 'items', items.length);

  return NextResponse.json(
    { items },
    {
      status: 200,
      headers: {
        'x-mu-list-source': 'mu_conversations',
        'x-mu-list-count': String(items.length),
      },
    }
  );
}
