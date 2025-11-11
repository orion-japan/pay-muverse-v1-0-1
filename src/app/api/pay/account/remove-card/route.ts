// app/api/pay/account/remove-card/route.ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import Payjp from 'payjp';
import { adminAuth } from '@/lib/firebase-admin';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || '';
const SERVICE_ROLE =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE || '';
const PAYJP_SECRET = process.env.PAYJP_SECRET_KEY || '';

if (!SUPABASE_URL || !SERVICE_ROLE || !PAYJP_SECRET) {
  throw new Error('Env missing: SUPABASE_URL / SERVICE_ROLE / PAYJP_SECRET_KEY');
}

const sb = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });
const payjp = (Payjp as any)(PAYJP_SECRET) as any;

type UserRow = {
  user_code: string;
  firebase_uid: string | null;
  payjp_customer_id: string | null;
  payjp_default_card_id: string | null;
};

/* ---------- logging ---------- */
const TAG = '[PAY][remove-card]';
const mkId = () => Math.random().toString(36).slice(2, 8);
const now = () => new Date().toISOString();
const log = (id: string, lvl: 'log' | 'warn' | 'error', msg: string, extra?: any) =>
  (console as any)[lvl](`${TAG}#${id} ${now()} ${msg}`, extra ?? '');

/* ---------- helpers ---------- */
function payjpErrInfo(e: any) {
  const status = e?.status || e?.response?.status || e?.response?.body?.error?.status;
  const body = e?.response?.body || e?.response?.text || e?.message || String(e);
  return { status, body };
}

// list cards with fallback (SDK差異に強く)
async function listCards(cusId: string, reqId: string) {
  const PAGE = 100;
  const out: any[] = [];
  // 1) customers.cards.list を試す
  try {
    for (let offset = 0; ; offset += PAGE) {
      const res = await payjp.customers.cards.list(cusId, { limit: PAGE, offset });
      const data: any[] = res?.data ?? [];
      out.push(...data);
      if (data.length < PAGE) break;
    }
    return out;
  } catch (e) {
    log(reqId, 'warn', `cards.list failed -> fallback retrieve`, payjpErrInfo(e));
  }
  // 2) 失敗時は customers.retrieve().cards.data
  const customer = await payjp.customers.retrieve(cusId);
  return (customer?.cards?.data ?? []) as any[];
}

async function deleteCard(cusId: string, cardId: string, reqId: string) {
  try {
    await payjp.customers.cards.delete(cusId, cardId);
    log(reqId, 'log', `deleted ${cardId}`);
    return true;
  } catch (e: any) {
    const info = payjpErrInfo(e);
    log(reqId, 'warn', `delete failed ${cardId}`, info);
    return false;
  }
}

// 列が無い環境でも落ちない DB クリア
async function clearDbCardState(user_code: string, reqId: string) {
  // フル更新
  const full = await sb
    .from('users')
    .update({
      card_registered: false,
      card_brand: null,
      card_last4: null,
      payjp_default_card_id: null,
    } as any)
    .eq('user_code', user_code)
    .select('user_code');
  if (!full.error && full.data?.length) {
    log(reqId, 'log', `DB clear (full) rows=${full.data.length}`);
    return { rows: full.data.length, mode: 'full' as const };
  }
  const msg = full.error?.message ?? '';
  if (full.error && /(column|does not exist|schema cache|not found)/i.test(msg)) {
    // 最小更新（存在する列だけ）
    log(reqId, 'warn', `DB full clear failed -> minimal: ${msg}`);
    let rows = 0;
    try {
      const r1 = await sb
        .from('users')
        .update({ card_registered: false })
        .eq('user_code', user_code)
        .select('user_code');
      rows = Math.max(rows, r1.data?.length ?? 0);
    } catch {}
    try {
      const r2 = await sb
        .from('users')
        .update({ payjp_default_card_id: null as any })
        .eq('user_code', user_code)
        .select('user_code');
      rows = Math.max(rows, r2.data?.length ?? 0);
    } catch {}
    try {
      await sb
        .from('users')
        .update({ card_brand: null as any })
        .eq('user_code', user_code);
    } catch {}
    try {
      await sb
        .from('users')
        .update({ card_last4: null as any })
        .eq('user_code', user_code);
    } catch {}
    log(reqId, 'log', `DB clear (minimal) rows=${rows}`);
    return { rows, mode: 'minimal' as const };
  }
  if (full.error) {
    log(reqId, 'error', `DB clear error`, full.error.message);
    throw full.error;
  }
  return { rows: full.data?.length ?? 0, mode: 'full' as const };
}

/* ---------- handler ---------- */
export async function POST(req: NextRequest) {
  const reqId = mkId();
  try {
    log(reqId, 'log', 'start');

    // auth
    const authHeader = req.headers.get('authorization') || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token)
      return NextResponse.json(
        { success: false, error: 'missing_id_token', reqId },
        { status: 401 },
      );
    let decoded: any;
    try {
      decoded = await adminAuth.verifyIdToken(token, true);
      log(reqId, 'log', `idToken ok uid:${decoded?.uid}`);
    } catch (e) {
      log(reqId, 'warn', 'invalid id token', e);
      return NextResponse.json(
        { success: false, error: 'invalid_id_token', reqId },
        { status: 401 },
      );
    }

    // body & user resolve
    const body = (await req.json().catch(() => ({}))) as any;
    const user_code_req: string | null = body?.user_code ?? null;

    let user: UserRow | null = null;
    if (user_code_req) {
      const { data, error } = await sb
      .from('users')
      .select(/* 既存の選択カラムそのまま */)
      .eq('user_code', user_code_req)
      .maybeSingle(); // ← 型引数を外す

    const userRow = data as unknown as UserRow | null; // ← 後段の既存参照に合わせて利用
      if (error || !data) {
        log(reqId, 'warn', `user_not_found by user_code:${user_code_req}`, error);
        return NextResponse.json(
          { success: false, error: 'user_not_found', reqId },
          { status: 404 },
        );
      }
      if (data.firebase_uid && data.firebase_uid !== decoded.uid) {
        log(reqId, 'warn', `forbidden mismatch`);
        return NextResponse.json(
          { success: false, error: 'forbidden_mismatch', reqId },
          { status: 403 },
        );
      }
      user = data;
    } else {
      const { data, error } = await sb
      .from('users')
      .select(/* 既存の選択カラムそのまま */)
      .eq('firebase_uid', decoded.uid)
      .maybeSingle(); // ← 型引数を外す

    const userRow = data as unknown as UserRow | null; // ← 後段の既存参照に合わせて利用

      if (error || !data) {
        log(reqId, 'warn', `user_not_found by uid:${decoded.uid}`, error);
        return NextResponse.json(
          { success: false, error: 'user_not_found', reqId },
          { status: 404 },
        );
      }
      user = data;
    }

    const user_code = user!.user_code;
    const cusId = user!.payjp_customer_id;
    const defaultCar = user!.payjp_default_card_id || null;
    log(
      reqId,
      'log',
      `resolved user_code=${user_code} cus=${cusId ?? 'null'} defaultCar=${defaultCar ?? 'null'}`,
    );

    // 顧客IDが無い → DBだけ整合させて終了（UI整合）
    if (!cusId) {
      const { rows, mode } = await clearDbCardState(user_code, reqId);
      if (rows === 0)
        return NextResponse.json(
          { success: false, error: 'db_update_failed', reqId },
          { status: 500 },
        );
      return NextResponse.json({
        success: true,
        info: 'no_customer_id(db_cleared)',
        db_update_mode: mode,
        reqId,
      });
    }

    // 1) default_card があれば先にピンポイント削除（速い）
    const deleted: string[] = [];
    if (defaultCar) {
      try {
        await payjp.customers.cards.delete(cusId, defaultCar);
        deleted.push(defaultCar);
        log(reqId, 'log', `deleted default ${defaultCar}`);
      } catch (e: any) {
        const status = e?.response?.status || e?.status;
        const bodyTxt = e?.response?.body || e?.message;
        // 404なら既に無いので無視、それ以外は返す
        if (status && status !== 404) {
          log(reqId, 'warn', `delete default failed`, { status, body: bodyTxt });
          return NextResponse.json(
            {
              success: false,
              error: 'payjp_delete_failed',
              debug: { status, body: bodyTxt },
              reqId,
            },
            { status: 502 },
          );
        }
      }
    }

    // 2) 念のため全カードを列挙→残りも削除
    let before: any[] = [];
    try {
      before = await listCards(cusId, reqId);
      log(
        reqId,
        'log',
        `cards before: ${before.length}`,
        before.map((c) => c.id),
      );
    } catch (e) {
      log(reqId, 'error', `list before failed`, payjpErrInfo(e));
      return NextResponse.json(
        { success: false, error: 'payjp_list_failed', reqId },
        { status: 502 },
      );
    }

    for (const c of before) {
      // default を既に消していれば二重で当たる可能性→握り潰して続行
      await deleteCard(cusId, c.id, reqId);
      deleted.push(c.id);
    }

    // 3) 検証：本当に 0 枚？
    let after: any[] = [];
    try {
      after = await listCards(cusId, reqId);
      log(
        reqId,
        'log',
        `cards after: ${after.length}`,
        after.map((c) => c.id),
      );
    } catch (e) {
      log(reqId, 'error', `list after failed`, payjpErrInfo(e));
      return NextResponse.json(
        { success: false, error: 'payjp_verify_failed', reqId },
        { status: 502 },
      );
    }

    if (after.length > 0) {
      return NextResponse.json(
        {
          success: false,
          error: 'payjp_cards_still_exist',
          customer_id: cusId,
          remain_card_ids: after.map((a) => a.id),
          deleted_card_ids: Array.from(new Set(deleted)),
          reqId,
        },
        { status: 502 },
      );
    }

    // 4) DB反映（default_card_id も null へ）※列不足はフォールバックで吸収
    const { rows, mode } = await clearDbCardState(user_code, reqId);
    if (rows === 0)
      return NextResponse.json(
        { success: false, error: 'db_update_failed', reqId },
        { status: 500 },
      );

    log(
      reqId,
      'log',
      `done deleted=${Array.from(new Set(deleted)).length} db_rows=${rows} mode=${mode}`,
    );
    return NextResponse.json({
      success: true,
      customer_id: cusId,
      deleted_card_ids: Array.from(new Set(deleted)),
      payjp_after_count: 0,
      db_rows_updated: rows,
      db_update_mode: mode,
      reqId,
    });
  } catch (e: any) {
    log(reqId, 'error', `unhandled`, e?.message || e);
    return NextResponse.json(
      { success: false, error: e?.message || 'error', reqId },
      { status: 500 },
    );
  }
}
