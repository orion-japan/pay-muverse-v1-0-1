// src/app/api/agent/iros/reply/route.ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { chatComplete, type ChatMessage } from '@/lib/llm/chatComplete';
import { adminClient } from '@/lib/credits/db';
import { verifyFirebaseAndAuthorize, normalizeAuthz } from '@/lib/authz';
import { IROS_SYSTEM } from '@/lib/iros/system';

/* ====== Config ====== */
const COST_PER_TURN = Number(process.env.IROS_COST_PER_TURN || 5);
const MODEL = process.env.IROS_MODEL || 'gpt-4o-mini';
const CREDITS_BYPASS = (process.env.CREDITS_BYPASS || '0') === '1';       // 1: 課金バイパス
const CAPTURE_SOFT_FAIL = (process.env.CAPTURE_SOFT_FAIL || '1') === '1'; // 1: 失敗でも落とさない

/* ====== helpers ====== */
const s = (v: unknown) => (v == null ? '' : String(v));

/* Credits API（user_code ベース・HTTP 経由） */
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

/* ====== auth normalize (robust) ====== */
type AnyAuth = any;
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
  try { body = await req.json(); } catch {}

  const supaAdmin = adminClient();
  let authed = { ok: false as boolean, userCode: undefined as string | undefined };

  try {
    /* 1) Firebase 認証 → 正規化 */
    const raw = await verifyFirebaseAndAuthorize(req);
    const a = pickAuth(raw);
    authed = { ok: a.ok, userCode: a.userCode };

    if (!authed.userCode) {
      return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
    }

    /* 2) 入力検証 */
    const conversationId: string = s(body?.conversationId).trim(); // uuid 文字列
    const user_text: string = s(body?.user_text).trim();
    const mode: string = s(body?.mode || 'Light');

    if (!conversationId || !user_text) {
      return NextResponse.json({ ok: false, error: 'INVALID_REQUEST' }, { status: 400 });
    }

    /* 3) 残高チェック（不足は 402 を即返す） */
    if (!CREDITS_BYPASS) {
      const { data: balData, error: balErr } = await supaAdmin.rpc('credit_get_balance', {
        p_user_code: authed.userCode,
      });
      if (balErr) throw new Error(`balance_failed: ${balErr.message}`);
      const balance = Number(balData ?? 0);
      if (balance < COST_PER_TURN) {
        return NextResponse.json(
          { ok: false, error: 'insufficient_credit', need: COST_PER_TURN, balance },
          { status: 402 }
        );
      }
    }

    /* 4) クレジット オーソライズ */
    const ref = s(body?.ref) || `iros:${conversationId}:${Date.now()}`;
    const okAuth = await authorize(baseUrl, authed.userCode!, COST_PER_TURN, ref);
    if (!okAuth) {
      return NextResponse.json({ ok: false, error: 'authorize_failed' }, { status: 402 });
    }

    /* 5) 直近履歴（最大10件） */
    const { data: history = [], error: histErr } = await supaAdmin
      .from('iros_messages')
      .select('role, text, content')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true })
      .limit(10);
    if (histErr) throw new Error(histErr.message);

    /* 6) プロンプト構成 */
    const messages: ChatMessage[] = [
      { role: 'system', content: (IROS_SYSTEM || '').toString().trim() },
      ...history.map((m: any) => ({
        role: (m.role === 'assistant' ? 'assistant' : 'user') as 'user' | 'assistant',
        content: s(m?.text ?? m?.content),
      })),
      { role: 'user', content: user_text },
    ];

    /* 7) LLM 呼び出し */
    const assistant: string = await chatComplete({
      model: MODEL,
      messages,
      temperature: 0.4,
      max_tokens: 640,
    });

    /* 8) 保存（user → assistant） */
    const nowIso = new Date().toISOString();
    const nowTs = Date.now();
    const meta = { q: null, phase: null, depth: null, confidence: null, mode };

    const { error: e2 } = await supaAdmin
      .from('iros_messages')
      .insert([
        {
          conversation_id: conversationId,   // uuid
          user_code: authed.userCode,        // text
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

    /* 9) 売上確定（失敗しても落とさないオプション） */
    const okCap = await capture(baseUrl, authed.userCode!, COST_PER_TURN, ref);
    if (!okCap) {
      console.warn('[credits] capture_failed', { user: authed.userCode, ref });
      if (!CAPTURE_SOFT_FAIL) {
        return NextResponse.json({ ok: false, error: 'capture_failed' }, { status: 500 });
      }
    }

    return NextResponse.json({
      ok: true,
      mode,
      assistant,
      credit: { captured: COST_PER_TURN, ref },
    });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: String(err?.message || 'error') }, { status: 500 });
  }
}
