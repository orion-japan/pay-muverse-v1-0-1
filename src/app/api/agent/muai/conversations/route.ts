// src/app/api/agent/muai/conversations/route.ts
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

const log = (...args: any[]) => console.log('[mu.conversations]', ...args);
const err = (...args: any[]) => console.error('[mu.conversations]', ...args);

/**
 * GET /api/agent/muai/conversations?limit=50
 * - ログインユーザー(z.userCode)の mu_conversations を新しい順に返す
 * - SofiaChat 側の「会話一覧」初期ロードで使用
 */
export async function GET(req: Request) {
  // 認可チェック（Firebaseトークン → userCode 抽出）
  const z = await verifyFirebaseAndAuthorize(req as any);
  if (!z.ok)    return NextResponse.json({ error: z.error }, { status: z.status });
  if (!z.allowed) return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  const url = new URL(req.url);
  const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit') ?? 50), 200));

  const s = sb();

  console.time('[mu.conversations] query');
  log('user', z.userCode, 'limit', limit);

  // ✅ mu_conversations を参照（必要な列だけ取得）
  const { data, error } = await s
    .from('mu_conversations')
    .select('id, title, updated_at, last_turn_at')
    .eq('user_code', z.userCode)
    .order('last_turn_at', { ascending: false, nullsFirst: false })
    .order('updated_at', { ascending: false })
    .limit(limit);

  console.timeEnd('[mu.conversations] query');

  if (error) {
    err('supabase error:', error);
    return NextResponse.json(
      { items: [], error: String(error.message || error) },
      {
        status: 200, // UI を壊さないため 200 で空配列返却
        headers: { 'x-mu-list-error': String(error.message || error) },
      }
    );
  }

  // UI 期待形式に整形
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
