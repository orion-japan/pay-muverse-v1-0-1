// src/app/api/agent/iros/reply/route.ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { chatComplete, type ChatMessage } from '@/lib/llm/chatComplete';
import { adminClient } from '@/lib/credits/db';
import { verifyFirebaseAndAuthorize, normalizeAuthz } from '@/lib/authz';

/* ====== Config ====== */
const COST_PER_TURN = Number(process.env.IROS_COST_PER_TURN || 5);
const MODEL = process.env.IROS_MODEL || 'gpt-4o-mini';
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || '';
const SUPABASE_ANON_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || '';
const CREDITS_BYPASS = (process.env.CREDITS_BYPASS || '0') === '1';

// 失敗しても 500 にしない（= 課金まわりの例外で落とさない）
const CAPTURE_SOFT_FAIL = (process.env.CAPTURE_SOFT_FAIL || '1') === '1';

/* ====== helpers ====== */
const asAny = (v: unknown) => v as any;

function userClient(pgJwt?: string): SupabaseClient {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
    global: { headers: pgJwt ? { Authorization: `Bearer ${pgJwt}` } : {} },
  });
}

/* Credits API（user_codeベース） */
async function authorize(baseUrl: string, user_code: string, amount: number, ref: string) {
  if (CREDITS_BYPASS) return true;
  try {
    const r = await fetch(`${baseUrl}/api/credits/authorize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify({ user_code, amount, ref }),
    });
    return r.ok;
  } catch (e) {
    console.warn('[credits] authorize error', e);
    return false;
  }
}
async function capture(baseUrl: string, user_code: string, amount: number, ref: string) {
  if (CREDITS_BYPASS) return true;
  try {
    const r = await fetch(`${baseUrl}/api/credits/capture`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify({ user_code, amount, ref }),
    });
    return r.ok;
  } catch (e) {
    console.warn('[credits] capture error', e);
    return false;
  }
}
async function voidAuth(baseUrl: string, user_code: string, amount: number, ref: string) {
  if (CREDITS_BYPASS) return;
  try {
    await fetch(`${baseUrl}/api/credits/void`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify({ user_code, amount, ref }),
    });
  } catch (e) {
    console.warn('[credits] void error', e);
  }
}

/* ====== auth normalize (robust) ====== */
type AnyAuth = any;
const s = (v: unknown) => (v == null ? '' : String(v));

function pickAuth(raw: AnyAuth) {
  const n = normalizeAuthz(raw) as AnyAuth;
  const x = { ...(raw || {}), ...(n || {}) };

  const userCode = s(x.userCode || x.user_code || x.uid || x.sub).trim() || undefined;
  const pgJwt = s(x.pgJwt || x.pg_jwt).trim() || undefined;
  const ok = !!userCode || !!x.ok || !!x.allowed || x.status === 200;

  return { ok, userCode, pgJwt, raw: x };
}

/* ====== handler ====== */
export async function POST(req: NextRequest) {
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || req.nextUrl.origin;

  let body: any = {};
  try {
    body = await req.json();
  } catch {}

  const supaAdmin = adminClient();

  let authed = {
    ok: false as boolean,
    userCode: undefined as string | undefined,
    pgJwt: undefined as string | undefined,
  };

  try {
    /* 1) Firebase 認証 → 正規化 */
    const raw = await verifyFirebaseAndAuthorize(req);
    const a = pickAuth(raw);
    authed.ok = a.ok;
    authed.userCode = a.userCode;
    authed.pgJwt = a.pgJwt;

    if (!authed.userCode) {
      return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
    }

    const supa = userClient(authed.pgJwt);

    /* 2) 入力検証 */
    const conversationId: string = s(body?.conversationId).trim();
    const user_text: string = s(body?.user_text).trim();
    const mode: string = s(body?.mode || 'Light');

    if (!conversationId || !user_text) {
      return NextResponse.json({ ok: false, error: 'INVALID_REQUEST' }, { status: 400 });
    }

    /* 3) クレジット オーソリ */
    const ref = `iros:${conversationId}:${Date.now()}`;
    const okAuth = await authorize(baseUrl, authed.userCode!, COST_PER_TURN, ref);
    if (!okAuth) {
      return NextResponse.json({ ok: false, error: 'insufficient_credit' }, { status: 402 });
    }

    /* 4) 直近履歴 */
    const { data: history = [] } = await supaAdmin
      .from('iros_messages')
      .select('role, text')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true })
      .limit(10);

    const messages: ChatMessage[] = [
      {
        role: 'system',
        content:
          process.env.IROS_SYSTEM_PROMPT ||
          'You are Iros, a concise partner AI. Reply briefly, actionable, and kind.',
      },
      ...history.map((m: any) => ({
        role: (m.role === 'assistant' ? 'assistant' : 'user') as 'user' | 'assistant',
        content: s(m?.text),
      })),
      { role: 'user', content: user_text },
    ];

    /* 5) LLM */
    const assistant: string = await chatComplete({
      model: MODEL,
      messages,
      temperature: 0.4,
      max_tokens: 420,
    });

    /* 6) メタ（暫定） */
    const meta = { q: null, phase: null, depth: null, confidence: null, mode };

    /* 7) 保存（user → assistant） */
    const nowIso = new Date().toISOString();
    const nowTs = Date.now();

    const { error: e2 } = await supaAdmin.from('iros_messages').insert([
      {
        conversation_id: conversationId,
        user_code: authed.userCode,
        role: 'user',
        content: user_text,
        text: user_text,
        meta: null,
        created_at: nowIso,
        ts: nowTs,
      },
      {
        conversation_id: conversationId,
        user_code: authed.userCode,
        role: 'assistant',
        content: assistant,
        text: assistant,
        meta,
        created_at: nowIso,
        ts: nowTs,
      },
    ]);
    if (e2) throw new Error(e2.message);

    /* 8) 売上確定（失敗しても落とさない） */
    const okCap = await capture(baseUrl, authed.userCode!, COST_PER_TURN, ref);
    if (!okCap) {
      console.warn('[credits] capture_failed (soft)', { user: authed.userCode, ref });
      if (!CAPTURE_SOFT_FAIL) {
        // 厳格モードにしたい場合のみエラー化（既定は落とさない）
        throw new Error('capture_failed');
      }
    }

    return NextResponse.json({ ok: true, mode, assistant });
  } catch (err: any) {
    // best-effort void（認証済み & 入力量が揃っているときのみ）
    try {
      const conversationId: string = s(body?.conversationId).trim();
      const user_text: string = s(body?.user_text).trim();
      if (conversationId && user_text && authed.userCode) {
        await voidAuth(baseUrl, authed.userCode, COST_PER_TURN, `iros:${conversationId}`);
      }
    } catch {}
    return NextResponse.json({ ok: false, error: String(err?.message || 'error') }, { status: 500 });
  }
}
