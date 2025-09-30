// src/app/api/agent/muai/turns/route.ts

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

const DEV = process.env.NODE_ENV !== 'production';
const NS = '[mu.turns]';
const rid = () => (globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2));
const log = (id: string, ...a: any[]) => { if (DEV) console.log(NS, id, ...a); };
const err = (id: string, ...a: any[]) => { if (DEV) console.error(NS, id, ...a); };
const time = (label: string) => DEV && console.time(label);
const timeEnd = (label: string) => DEV && console.timeEnd(label);

// "bot" 等を DB の enum に合わせて正規化
function normalizeRole(input: unknown): 'user' | 'assistant' {
  const r = String(input ?? '').toLowerCase();
  if (r === 'assistant' || r === 'bot' || r === 'system') return 'assistant';
  if (r === 'user') return 'user';
  return 'user';
}

export async function GET(req: Request) {
  const id = rid();
  const t0 = Date.now();
  log(id, 'GET start');

  // ① 先に conv_id を見て、new は空で返す（未認証でOK）
  const url = new URL(req.url);
  const convId = url.searchParams.get('conv_id');
  if (!convId) {
    return NextResponse.json(
      { error: 'missing conv_id' },
      { status: 400, headers: { 'x-mu-req': id } },
    );
  }
  if (convId === 'new') {
    log(id, 'GET ok (new placeholder)', { convId, count: 0, ms: Date.now() - t0 });
    return NextResponse.json({ items: [], rows: [] }, { headers: { 'x-mu-req': id } });
  }

  // ② ここから先は既存スレッド → 認証必須
  const z = await verifyFirebaseAndAuthorize(req as any);
  if (!z.ok) return NextResponse.json({ error: z.error }, { status: z.status, headers: { 'x-mu-req': id } });
  if (!z.allowed) return NextResponse.json({ error: 'forbidden' }, { status: 403, headers: { 'x-mu-req': id } });

  const s = sb();

  try {
    const tlabel = `${NS} ${id} check conv`;
    time(tlabel);
    const { data: conv, error: convErr } = await s
      .from('mu_conversations')
      .select('id')
      .eq('id', convId)
      .single();
    timeEnd(tlabel);
    if (convErr || !conv) {
      err(id, 'conversation not found', { convId, message: convErr?.message });
      return NextResponse.json({ error: 'conversation not found' }, { status: 404, headers: { 'x-mu-req': id } });
    }
  } catch (e) {
    err(id, 'verify conversation failed', { convId, e });
    return NextResponse.json({ error: 'failed to verify conversation' }, { status: 500, headers: { 'x-mu-req': id } });
  }

  const tlabel2 = `${NS} ${id} list turns`;
  time(tlabel2);
  const { data, error } = await s
    .from('mu_turns')
    .select('id, role, content, used_credits, created_at')
    .eq('conv_id', convId)
    .order('created_at', { ascending: true });
  timeEnd(tlabel2);

  if (error) {
    err(id, 'supabase error', { message: error.message });
    return NextResponse.json({ error: String(error.message || error) }, { status: 500, headers: { 'x-mu-req': id } });
  }

  const items = (data ?? []).map((row) => ({
    id: row.id,
    role: row.role,
    content: row.content,
    used_credits: row.used_credits,
    created_at: row.created_at,
  }));

  log(id, 'GET ok', { convId, count: items.length, ms: Date.now() - t0 });
  // 互換のため rows も同梱（古いUIが rows を参照しても表示される）
  return NextResponse.json({ items, rows: items }, { headers: { 'x-mu-req': id } });
}

export async function POST(req: Request) {
  const id = rid();
  const t0 = Date.now();
  log(id, 'POST start');

  // 認証必須
  const z = await verifyFirebaseAndAuthorize(req as any);
  if (!z.ok) return NextResponse.json({ error: z.error }, { status: z.status, headers: { 'x-mu-req': id } });
  if (!z.allowed) return NextResponse.json({ error: 'forbidden' }, { status: 403, headers: { 'x-mu-req': id } });

  // 入力
  let body: any = {};
  try { body = await req.json(); } catch {}
  const { conv_id, role, content, meta } = body ?? {};

  // ここで role を正規化（"bot"/"system" -> "assistant"、未指定は "user"）
  const safeRole = normalizeRole(role);

  if (!conv_id || typeof content !== 'string' || content.length === 0) {
    err(id, 'bad request', { hasConv: Boolean(conv_id), role, contentType: typeof content });
    return NextResponse.json(
      { error: 'conv_id and content are required' },
      { status: 400, headers: { 'x-mu-req': id } },
    );
  }

  const s = sb();
  const tlabel = `${NS} ${id} insert turn`;
  time(tlabel);
  const { data, error } = await s
    .from('mu_turns')
    .insert({
      conv_id,
      role: safeRole,     // ← enum対策：正規化済み
      content,
      meta: meta ?? null,
      user_code: z.userCode, // だれが書いたか残す
    })
    .select('id')
    .single();
  timeEnd(tlabel);

  if (error) {
    err(id, 'insert error', { message: error.message });
    return NextResponse.json({ error: String(error.message || error) }, { status: 500, headers: { 'x-mu-req': id } });
  }

  log(id, 'POST ok', { conv_id, id: data?.id, role: safeRole, ms: Date.now() - t0 });
  return NextResponse.json({ ok: true, id: data?.id }, { headers: { 'x-mu-req': id } });
}
