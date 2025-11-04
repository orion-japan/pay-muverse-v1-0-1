// src/app/api/resolve-so/route.ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { adminAuth } from '@/lib/firebase-admin';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { makeSignedParams } from '@/lib/signed';
import { randomUUID } from 'crypto';

/** =========================
 *  Env（SO 固定）
 *  - SOFIA_UI_URL / NEXT_PUBLIC_SOFIA_UI_URL に統一
 *  - SO_UI_URL は使いません（誤設定の元）
 * ========================= */
const SOFIA_UI_URL = (
  process.env.SOFIA_UI_URL ||
  process.env.NEXT_PUBLIC_SOFIA_UI_URL ||
  'https://s.muverse.jp'
).replace(/\/+$/, '');

const SO_SHARED_ACCESS_SECRET =
  process.env.SO_SHARED_ACCESS_SECRET || process.env.MU_SHARED_ACCESS_SECRET || '';

function genUserCode() {
  return 'uc-' + randomUUID().slice(0, 8);
}

async function extractIdToken(req: NextRequest) {
  const authz = req.headers.get('authorization') || req.headers.get('Authorization');
  if (authz?.toLowerCase().startsWith('bearer ')) return authz.slice(7).trim();

  if (req.method === 'POST') {
    try {
      const body = await req.json().catch(() => ({}) as any);
      const t = body?.idToken || body?.auth?.idToken;
      if (t && typeof t === 'string') return t;
    } catch {}
  }
  const q = new URL(req.url).searchParams.get('idToken');
  return q || null;
}

async function handle(req: NextRequest) {
  const rid = Math.random().toString(36).slice(2, 8);

  // ── boot logs ───────────────────────────────────────
  console.log(`[resolve-so#${rid}] Init`);
  console.log(`[resolve-so#${rid}] env.SOFIA_UI_URL=`, SOFIA_UI_URL);
  // ───────────────────────────────────────────────────

  try {
    if (!SO_SHARED_ACCESS_SECRET) {
      console.error(`[resolve-so#${rid}] missing SO_SHARED_ACCESS_SECRET`);
      return NextResponse.json({ ok: false, error: 'SERVER_MISCONFIG' }, { status: 500 });
    }

    const idToken = await extractIdToken(req);
    if (!idToken) {
      console.warn(`[resolve-so#${rid}] no idToken`);
      return NextResponse.json({ ok: false, error: 'INVALID_TOKEN' }, { status: 400 });
    }

    const decoded = await adminAuth.verifyIdToken(idToken, true);
    const firebase_uid = decoded.uid;
    console.log(`[resolve-so#${rid}] uid=`, firebase_uid);

    // 既存取得（必須3列）
    let { data, error } = await supabaseAdmin
      .from('users')
      .select('user_code, click_type, sofia_credit')
      .eq('firebase_uid', firebase_uid)
      .maybeSingle();

    if (error || !data?.user_code) {
      console.warn(`[resolve-so#${rid}] user not found → provision`);
      const user_code = genUserCode();
      const ins = await supabaseAdmin
        .from('users')
        .insert({ firebase_uid, user_code, click_type: 'user', sofia_credit: 0 })
        .select('user_code, click_type, sofia_credit')
        .maybeSingle();

      if (ins.error) {
        // unique 衝突なら再取得
        if ((ins.error as any).code === '23505') {
          console.warn(`[resolve-so#${rid}] conflict → reselect`);
          const again = await supabaseAdmin
            .from('users')
            .select('user_code, click_type, sofia_credit')
            .eq('firebase_uid', firebase_uid)
            .maybeSingle();
          if (again.error || !again.data?.user_code) {
            console.error(`[resolve-so#${rid}] select failed`, again.error);
            return NextResponse.json(
              {
                ok: false,
                error: 'USER_PROVISION_FAILED',
                detail: String(again.error?.message ?? 'select failed'),
              },
              { status: 500 },
            );
          }
          data = again.data;
        } else {
          console.error(`[resolve-so#${rid}] insert failed`, ins.error);
          return NextResponse.json(
            {
              ok: false,
              error: 'USER_PROVISION_FAILED',
              detail: String(ins.error?.message ?? ins.error),
            },
            { status: 500 },
          );
        }
      } else {
        data = ins.data;
      }
    }

    // 署名付き SO ログインURLを生成（SO 固定、from=so 固定）
    const user_code = data!.user_code;
    const { ts, sig } = makeSignedParams(user_code, SO_SHARED_ACCESS_SECRET);

    const u = new URL(SOFIA_UI_URL);
    u.searchParams.set('user', user_code);
    u.searchParams.set('ts', String(ts));
    u.searchParams.set('sig', sig);
    u.searchParams.set('from', 'so'); // ★ ここが肝：必ず so
    u.searchParams.set('tenant', 'sofia'); // 必要に応じて付与
    // hideHeader はフロントで最終付与でもOK

    // ロール
    const click = String(data!.click_type ?? '').toLowerCase();
    const is_admin = click === 'admin';
    const is_master = click === 'master';

    const login_url = u.toString();

    // ── output logs ───────────────────────────────────
    console.log(`[resolve-so#${rid}] payload`, {
      tenant: 'sofia',
      user_code,
      click_type: click,
      sofia_credit: Number(data!.sofia_credit ?? 0),
      is_admin,
      is_master,
    });
    console.log(`[resolve-so#${rid}] OK ->`, login_url);
    // ─────────────────────────────────────────────────

    return NextResponse.json({
      ok: true,
      tenant: 'sofia',
      user_code,
      click_type: click,
      sofia_credit: Number(data!.sofia_credit ?? 0),
      is_admin,
      is_master,
      login_url,
    });
  } catch (e: any) {
    console.error(`[resolve-so#${rid}] fatal:`, e);
    return NextResponse.json({ ok: false, error: e?.message || 'INTERNAL' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  return handle(req);
}
export async function GET(req: NextRequest) {
  return handle(req);
}
