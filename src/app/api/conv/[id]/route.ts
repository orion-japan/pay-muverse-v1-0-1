// src/app/api/conv/[id]/route.ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { verifyFirebaseAndAuthorize } from '@/lib/authz';

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY; // あればこれを使用（RLSをバイパス）
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

// ★ 正しいテーブル名に修正
const TABLE = 'sofia_conversations';

function sb() {
  const key = SERVICE_KEY ?? ANON_KEY;
  return createClient(URL, key, { auth: { persistSession: false } });
}

function mapSupabaseStatus(message?: string) {
  const m = (message ?? '').toLowerCase();
  if (
    m.includes('row-level security') ||
    m.includes('permission denied')
  ) return 403;
  return 500;
}

// PATCH /api/conv/:id  { title: string }
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const z = await verifyFirebaseAndAuthorize(req);
    if (!z.ok || !z.userCode) {
      return NextResponse.json({ error: z.error ?? 'unauthorized' }, { status: z.status ?? 401 });
    }

    const payload = (await req.json()) as { title?: string | null };
    const title = (payload?.title ?? '').trim();
    if (!title) {
      return NextResponse.json({ error: 'title is required' }, { status: 400 });
    }

    const client = sb();
    const { data, error } = await client
      .from(TABLE)
      .update({ title, updated_at: new Date().toISOString() })
      .eq('conversation_code', params.id) // ← sofia_conversations にはこの列がある
      .eq('user_code', z.userCode)
      .select('conversation_code, title')
      .maybeSingle();

    if (error) {
      const status = mapSupabaseStatus(error.message);
      return NextResponse.json({ error: error.message }, { status });
    }
    if (!data) return NextResponse.json({ error: 'not found' }, { status: 404 });

    return NextResponse.json({
      id: data.conversation_code,
      title: data.title ?? '無題のセッション',
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? 'internal error' }, { status: 500 });
  }
}

// DELETE /api/conv/:id
export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const z = await verifyFirebaseAndAuthorize(req);
    if (!z.ok || !z.userCode) {
      return NextResponse.json({ error: z.error ?? 'unauthorized' }, { status: z.status ?? 401 });
    }

    const client = sb();
    const { error } = await client
      .from(TABLE)
      .delete()
      .eq('conversation_code', params.id)
      .eq('user_code', z.userCode);

    if (error) {
      const status = mapSupabaseStatus(error.message);
      return NextResponse.json({ error: error.message }, { status });
    }

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? 'internal error' }, { status: 500 });
  }
}
