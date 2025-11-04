// src/app/api/q/audit/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { verifyFirebaseAndAuthorize } from '@/lib/authz';

// ---- Supabase 管理者クライアント（Service Role 専用） ----
// SUPABASE_URL が無ければ NEXT_PUBLIC_SUPABASE_URL を使うフォールバック
// SUPABASE_SERVICE_ROLE は SUPABASE_SERVICE_ROLE_KEY でも可
function adminSb() {
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL; // ← フォールバック

  const key = process.env.SUPABASE_SERVICE_ROLE ?? process.env.SUPABASE_SERVICE_ROLE_KEY; // ← 別名も許可

  if (!url || !key) {
    // 何が無いかを簡易表示（キーは先頭だけ）
    const urlInfo = url ? 'ok' : 'missing';
    const keyInfo = key ? `ok(${key.slice(0, 6)}...)` : 'missing';
    throw new Error(`Missing env -> SUPABASE_URL:${urlInfo} / SERVICE_ROLE:${keyInfo}`);
  }

  return createClient(url, key, { auth: { persistSession: false } });
}

// ---- POST: 監査ログを追加 ----
export async function POST(req: NextRequest) {
  try {
    const authz = await verifyFirebaseAndAuthorize(req);
    if (!authz.ok || !authz.userCode) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: authz.status });
    }

    const body = await req.json().catch(() => ({}));
    const { used_source, q_value, influence_w, why_not_q } = body || {};

    if (!used_source || !q_value) {
      return NextResponse.json(
        { ok: false, error: 'missing params (used_source, q_value)' },
        { status: 400 },
      );
    }

    const sb = adminSb();
    const { error } = await sb.from('q_code_audits').insert({
      user_code: authz.userCode,
      used_source,
      q_value,
      influence_w: influence_w ?? 0,
      why_not_q: why_not_q ?? null,
    });

    if (error) {
      console.error('[q/audit] insert error:', error);
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    console.error('[q/audit] POST error:', e);
    return NextResponse.json({ ok: false, error: e?.message || 'server error' }, { status: 500 });
  }
}

// ---- GET: 直近の監査ログを取得 ----
export async function GET(req: NextRequest) {
  try {
    const authz = await verifyFirebaseAndAuthorize(req);
    if (!authz.ok || !authz.userCode) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: authz.status });
    }

    const sb = adminSb();
    const { data, error } = await sb
      .from('q_code_audits')
      .select('id, used_source, q_value, influence_w, why_not_q, created_at')
      .eq('user_code', authz.userCode)
      .order('created_at', { ascending: false })
      .limit(20);

    if (error) {
      console.error('[q/audit] select error:', error);
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }

    return NextResponse.json({ ok: true, data });
  } catch (e: any) {
    console.error('[q/audit] GET error:', e);
    return NextResponse.json({ ok: false, error: e?.message || 'server error' }, { status: 500 });
  }
}
