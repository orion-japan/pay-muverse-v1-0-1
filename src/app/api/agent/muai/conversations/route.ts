// src/app/api/agent/muai/conversations/route.ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { verifyFirebaseAndAuthorize, SUPABASE_URL, SERVICE_ROLE } from '@/lib/authz';

function sb() {
  return createClient(SUPABASE_URL!, SERVICE_ROLE!, {
    auth: { persistSession: false },
  });
}

const NS = '[mu.conversations]';
const rid = () => globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
const log = (id: string, ...a: any[]) => console.log(NS, id, ...a);
const err = (id: string, ...a: any[]) => console.error(NS, id, ...a);

/**
 * GET /api/agent/muai/conversations?limit=50
 */
export async function GET(req: Request) {
  const id = rid();
  const t0 = Date.now();
  log(id, 'GET start', { url: String(new URL(req.url)), ua: req.headers.get('user-agent') });

  const z = await verifyFirebaseAndAuthorize(req as any);
  if (!z.ok) {
    err(id, 'auth fail', { status: z.status, error: z.error });
    return NextResponse.json({ error: z.error }, { status: z.status, headers: { 'x-mu-req': id } });
  }
  if (!z.allowed) {
    err(id, 'forbidden', { user: z.userCode });
    return NextResponse.json({ error: 'forbidden' }, { status: 403, headers: { 'x-mu-req': id } });
  }

  const url = new URL(req.url);
  const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit') ?? 50), 200));

  const s = sb();
  console.time(`${NS} ${id} query`);
  log(id, 'query begin', { user: z.userCode, limit });

  let data: any[] | null = null;
  let reuseCapable = true;

  // まず reuse_key を含めて取得を試みる
  try {
    const r1 = await s
      .from('mu_conversations')
      .select('id, title, updated_at, last_turn_at, reuse_key, origin_app')
      .eq('user_code', z.userCode)
      .order('last_turn_at', { ascending: false, nullsFirst: false })
      .order('updated_at', { ascending: false });
    if (r1.error) throw r1.error;
    data = r1.data ?? [];
  } catch (e: any) {
    reuseCapable = false; // reuse_key が無い環境を想定してフォールバック
    log(id, 'fallback without reuse_key', { reason: e?.message });
    const r2 = await s
      .from('mu_conversations')
      .select('id, title, updated_at, last_turn_at, origin_app')
      .eq('user_code', z.userCode)
      .order('last_turn_at', { ascending: false, nullsFirst: false })
      .order('updated_at', { ascending: false });
    if (r2.error) {
      console.timeEnd(`${NS} ${id} query`);
      err(id, 'supabase error', { message: r2.error.message });
      return NextResponse.json(
        { items: [], error: String(r2.error.message || r2.error) },
        {
          status: 200,
          headers: { 'x-mu-req': id, 'x-mu-list-error': String(r2.error.message || r2.error) },
        },
      );
    }
    data = r2.data ?? [];
  }

  console.timeEnd(`${NS} ${id} query`);

  // ---- 同一スレッドの集約（再利用キー優先・無ければタイトル単位）----
  let dedupSorted: any[] = [];
  if (reuseCapable) {
    const byKey = new Map<string, any>();
    for (const r of data!) {
      const key = r.reuse_key || r.id;
      const prev = byKey.get(key);
      const tPrev = prev ? new Date(prev.last_turn_at ?? prev.updated_at ?? 0).getTime() : -1;
      const tThis = new Date(r.last_turn_at ?? r.updated_at ?? 0).getTime();
      if (!prev || tThis > tPrev) byKey.set(key, r);
    }
    dedupSorted = [...byKey.values()];
  } else {
    // reuse_key が使えない場合は (title, origin_app) 単位で最新を残す
    const byTitle = new Map<string, any>();
    for (const r of data!) {
      const key = `${r.origin_app ?? 'mu'}::${r.title ?? ''}`;
      const prev = byTitle.get(key);
      const tPrev = prev ? new Date(prev.last_turn_at ?? prev.updated_at ?? 0).getTime() : -1;
      const tThis = new Date(r.last_turn_at ?? r.updated_at ?? 0).getTime();
      if (!prev || tThis > tPrev) byTitle.set(key, r);
    }
    dedupSorted = [...byTitle.values()];
  }

  dedupSorted.sort((a, b) => {
    const ta = new Date(a.last_turn_at ?? a.updated_at ?? 0).getTime();
    const tb = new Date(b.last_turn_at ?? b.updated_at ?? 0).getTime();
    return tb - ta;
  });

  const items = dedupSorted.slice(0, limit).map((row) => ({
    id: row.id,
    title: row.title ?? 'Mu 会話',
    updated_at: row.last_turn_at ?? row.updated_at ?? null,
  }));

  const ms = Date.now() - t0;
  log(id, 'GET ok', { user: z.userCode, items: items.length, ms });

  return NextResponse.json(
    { items },
    {
      status: 200,
      headers: {
        'x-mu-req': id,
        'x-mu-list-source': 'mu_conversations',
        'x-mu-list-count': String(items.length),
      },
    },
  );
}

/**
 * POST /api/agent/muai/conversations  { op:'find_or_create', key, title, meta? }
 */
export async function POST(req: Request) {
  const id = rid();
  const t0 = Date.now();
  log(id, 'POST start');

  const z = await verifyFirebaseAndAuthorize(req as any);
  if (!z.ok) {
    err(id, 'auth fail', { status: z.status, error: z.error });
    return NextResponse.json({ error: z.error }, { status: z.status, headers: { 'x-mu-req': id } });
  }
  if (!z.allowed) {
    err(id, 'forbidden', { user: z.userCode });
    return NextResponse.json({ error: 'forbidden' }, { status: 403, headers: { 'x-mu-req': id } });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    err(id, 'invalid json');
    return NextResponse.json(
      { error: 'invalid json' },
      { status: 400, headers: { 'x-mu-req': id } },
    );
  }

  const op = body?.op;
  const key = body?.key as string | undefined;
  const title = body?.title as string | undefined;
  const meta = (body?.meta ?? {}) as Record<string, any>;
  log(id, 'payload', { op, hasKey: Boolean(key), title });

  if (op !== 'find_or_create' || !title || !key) {
    err(id, 'bad request');
    return NextResponse.json(
      { error: 'bad request: op=find_or_create, key, title required' },
      { status: 400, headers: { 'x-mu-req': id } },
    );
  }

  const userCode: string | undefined = z.userCode;
  if (!userCode) {
    err(id, 'missing userCode');
    return NextResponse.json(
      { error: 'missing userCode' },
      { status: 400, headers: { 'x-mu-req': id } },
    );
  }

  const s = sb();

  let existingId: string | null = null;

  // reuse_key での再利用検索（カラムが無いならスキップ）
  try {
    console.time(`${NS} ${id} find reuse_key`);
    const { data: found, error: fErr } = await s
      .from('mu_conversations')
      .select('id')
      .eq('user_code', userCode)
      .eq('reuse_key', key)
      .limit(1);
    console.timeEnd(`${NS} ${id} find reuse_key`);
    if (!fErr && found && found.length) existingId = found[0].id;
  } catch (e) {
    log(id, 'reuse_key lookup skipped', { reason: 'maybe column missing' });
  }

  // タイトル・origin_app=mu での再利用（後方互換）
  if (!existingId) {
    console.time(`${NS} ${id} find title`);
    const { data: found2 } = await s
      .from('mu_conversations')
      .select('id')
      .eq('user_code', userCode)
      .eq('title', title)
      .eq('origin_app', 'mu')
      .limit(1);
    console.timeEnd(`${NS} ${id} find title`);
    if (found2 && found2.length) existingId = found2[0].id;
  }

  if (existingId) {
    log(id, 'reuse', { userCode, key, title, id: existingId, ms: Date.now() - t0 });
    return NextResponse.json(
      { threadId: existingId, reused: true },
      { headers: { 'x-mu-req': id } },
    );
  }

  const basePayload: any = {
    user_code: userCode,
    title,
    origin_app: 'mu',
    routed_from: meta?.routed_from ?? 'q-summary',
  };
  let insertedId: string | null = null;

  // 1st: reuse_key + meta 付きで INSERT
  try {
    console.time(`${NS} ${id} insert with meta`);
    const { data: ins, error: insErr } = await s
      .from('mu_conversations')
      .insert({ ...basePayload, reuse_key: key, meta })
      .select('id')
      .single();
    console.timeEnd(`${NS} ${id} insert with meta`);
    if (insErr) throw insErr;
    insertedId = ins?.id ?? null;
  } catch (e: any) {
    err(id, 'insert with meta failed, fallback', { message: e?.message });

    // 2nd: 最小 INSERT（reuse_key / meta を完全に外す）
    console.time(`${NS} ${id} insert minimal`);
    const { data: ins2, error: e2 } = await s
      .from('mu_conversations')
      .insert(basePayload)
      .select('id')
      .single();
    console.timeEnd(`${NS} ${id} insert minimal`);
    if (e2) {
      err(id, 'insert minimal failed', { message: e2.message });
      return NextResponse.json(
        { error: String(e2.message || e2) },
        { status: 500, headers: { 'x-mu-req': id } },
      );
    }
    insertedId = ins2?.id ?? null;
  }

  log(id, 'created', { userCode, key, title, id: insertedId, ms: Date.now() - t0 });
  return NextResponse.json(
    { threadId: insertedId, reused: false },
    { headers: { 'x-mu-req': id } },
  );
}
