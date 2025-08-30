// app/api/account-status/route.ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { adminAuth } from '@/lib/firebase-admin';

/* =========================
   Supabase Admin Client
========================= */
const SUPABASE_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || '';
const SERVICE_ROLE =
  process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_SERVICE_ROLE_KEY || '';

if (!SUPABASE_URL || !SERVICE_ROLE) {
  throw new Error('Env missing: NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE');
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

/* =========================
   型
========================= */
type UserRow = {
  user_code: string;
  click_type: string | null;
  plan_status?: string | null;
  next_payment_date?: string | null;
  last_payment_date?: string | null;

  card_registered: boolean | null;
  card_brand?: string | null;
  card_last4?: string | null;

  payjp_customer_id: string | null;
  sofia_credit: number | null;

  click_email: string | null;
  email_verified: boolean | null;
  firebase_uid?: string | null;
};

const SELECT_FIELDS_NEW = [
  'user_code',
  'click_type',
  'plan_status',
  'next_payment_date',
  'last_payment_date',
  'card_registered',
  'card_brand',
  'card_last4',
  'payjp_customer_id',
  'sofia_credit',
  'click_email',
  'email_verified',
  'firebase_uid',
].join(', ');

const SELECT_FIELDS_LEGACY = [
  'user_code',
  'click_type',
  'plan_status',
  'next_payment_date',
  'last_payment_date',
  'card_registered',
  'payjp_customer_id',
  'sofia_credit',
  'click_email',
  'email_verified',
  'firebase_uid',
].join(', ');

/* =========================
   共通レスポンス（no-store）
========================= */
function json(data: any, init?: number | ResponseInit) {
  const res = NextResponse.json(data, init as any);
  res.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  return res;
}

/* =========================
   Users 取得（互換）
========================= */
async function getUserSingle(where: { col: string; val: string }) {
  let q = supabase.from('users').select(SELECT_FIELDS_NEW).eq(where.col, where.val).maybeSingle();
  let r = (await q) as { data: UserRow | null; error: any };
  if (!r.error) return r;

  const msg = String(r.error?.message || r.error || '');
  if (/column|card_brand|card_last4/i.test(msg)) {
    const r2 = (await supabase
      .from('users')
      .select(SELECT_FIELDS_LEGACY)
      .eq(where.col, where.val)
      .maybeSingle()) as { data: any; error: any };
    if (!r2.error && r2.data) {
      const d: UserRow = { ...r2.data, card_brand: null, card_last4: null };
      return { data: d, error: null };
    }
    return r2 as any;
  }
  return r;
}

/* =========================
   plan_history 取得
========================= */
async function loadHistory(user_code: string) {
  try {
    const { data, error } = await supabase
      .from('plan_history')
      .select('id, event, plan_status, click_type, valid_until, source, note, created_at')
      .eq('user_code', user_code)
      .order('created_at', { ascending: false })
      .limit(50);
    if (error || !data) return [];
    return data.map((row: any) => ({
      id: row.id,
      created_at: row.created_at,
      event: row.event,
      plan_status: row.plan_status,
      click_type: row.click_type,
      valid_until: row.valid_until,
      source: row.source,
      note: row.note,
      // 旧UI互換
      started_at: row.created_at,
      ended_at: null,
      from_plan_status: null,
      to_plan_status: row.plan_status,
      from_click_type: null,
      to_click_type: row.click_type,
      reason: row.note?.reason ?? row.event,
    }));
  } catch {
    return [];
  }
}

function toResp(d: UserRow, history: any[] = []) {
  return {
    user_code: d.user_code,
    plan_status: d.plan_status ?? d.click_type ?? 'free',
    plan_valid_until: d.next_payment_date ?? null,
    last_payment_date: d.last_payment_date ?? null,
    card_registered: d.card_registered === true,
    card_brand: d.card_brand ?? null,
    card_last4: d.card_last4 ?? null,
    payjp_customer_id: d.payjp_customer_id ?? null,
    sofia_credit: d.sofia_credit ?? 0,
    click_email: d.click_email ?? '',
    email_verified: d.email_verified === true,
    history,
  };
}

/* =========================
   user_code 生成
========================= */
async function generateUserCode(): Promise<string> {
  for (let i = 0; i < 8; i++) {
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const { data } = (await supabase
      .from('users')
      .select('user_code')
      .eq('user_code', code)
      .maybeSingle()) as { data: { user_code: string } | null; error: any };
    if (!data) return code;
  }
  return String(Date.now()).slice(-6);
}

/* =========================
   Token 抽出 & 検証（暫定止血版）
========================= */
function pickToken(req: NextRequest) {
  const authHeader = req.headers.get('authorization') || '';
  if (authHeader.startsWith('Bearer ')) return authHeader.slice(7);
  const x = req.headers.get('x-id-token');
  if (x) return x;
  return null;
}

async function verifyIdTokenSoft(token: string) {
  // まず「通常検証」で通す
  try {
    const decoded = await adminAuth.verifyIdToken(token);
    return decoded;
  } catch (e: any) {
    // 明らかな期限切れ・形式不正は即失敗
    if (e?.code && /expired|argument|invalid/i.test(e.code)) throw e;
    // リフレッシュ直後の撤回扱い等は厳格チェックを外して再試行済みなので、そのまま失敗
    throw e;
  }
}

/* =========================
   Handlers
========================= */
export async function OPTIONS() {
  // CORS プリフライト想定（必要なら許可ヘッダを追加）
  return new NextResponse(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(req: NextRequest) {
  try {
    const token = pickToken(req);
    if (!token) return json({ error: '認証トークンがありません' }, { status: 401 });

    let decoded: any;
    try {
      decoded = await verifyIdTokenSoft(token);
    } catch (e: any) {
      console.error('[AUTH] verify failed:', e?.code || e?.message || e);
      // クライアント側で getIdToken(true) を促すための明示コード
      return json({ error: '無効なトークンです', needRefresh: true }, { status: 403 });
    }

    const firebase_uid: string = decoded.uid;
    const email: string | null = decoded.email ?? null;
    const emailVerified: boolean = !!decoded.email_verified;

    // uid で検索
    let { data, error } = await getUserSingle({ col: 'firebase_uid', val: firebase_uid });

    // 見つからなければ email で救済
    if ((!data || error) && email) {
      let r = (await supabase
        .from('users')
        .select(SELECT_FIELDS_NEW)
        .ilike('click_email', email as string)
        .limit(1)) as { data: UserRow[] | null; error: any };

      if (r.error && /column|card_brand|card_last4/i.test(String(r.error?.message || ''))) {
        r = (await supabase
          .from('users')
          .select(SELECT_FIELDS_LEGACY)
          .ilike('click_email', email as string)
          .limit(1)) as any;
        if (!r.error && r.data && r.data[0]) {
          r.data[0].card_brand = null;
          r.data[0].card_last4 = null;
        }
      }

      if (!r.error && r.data && r.data[0]) {
        data = r.data[0] as UserRow;
        error = null;
        // uid / email を同期
        const updates: Record<string, any> = {};
        if (!data.firebase_uid) updates.firebase_uid = firebase_uid;
        if (!data.click_email && email) updates.click_email = email.toLowerCase();
        if (Object.keys(updates).length > 0) {
          await supabase.from('users').update(updates).eq('user_code', data.user_code);
        }
      } else {
        error = r.error ?? error;
      }
    }

    // 無ければ自動作成
    if (!data) {
      const user_code = await generateUserCode();
      const insertPayload = {
        user_code,
        click_type: 'free',
        plan_status: 'free',
        sofia_credit: 0,
        card_registered: false,
        click_email: email ? email.toLowerCase() : null,
        email_verified: emailVerified,
        firebase_uid,
      };

      const ins = (await supabase
        .from('users')
        .insert(insertPayload as any)
        .select(SELECT_FIELDS_LEGACY)
        .single()) as { data: UserRow | null; error: any };

      if (ins.error) {
        const ins2 = (await supabase
          .from('users')
          .select(SELECT_FIELDS_NEW)
          .eq('user_code', user_code)
          .maybeSingle()) as { data: UserRow | null; error: any };

        if (ins2.error || !ins2.data) {
          return json(
            { error: 'User bootstrap failed', detail: ins.error?.message || ins2.error?.message || null },
            { status: 500 }
          );
        }
        data = ins2.data;
      } else {
        data = { ...(ins.data as any), card_brand: null, card_last4: null } as UserRow;
      }
    }

    const history = await loadHistory((data as UserRow).user_code);
    return json(toResp(data as UserRow, history));
  } catch (err: any) {
    console.error('[account-status] fatal', err);
    return json({ error: '認証エラー' }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const user_code = searchParams.get('user');
    if (!user_code) return json({ error: 'No user_code provided' }, { status: 400 });

    const { data, error } = await getUserSingle({ col: 'user_code', val: user_code });
    if (error || !data) return json({ error: 'User not found' }, { status: 404 });

    const history = await loadHistory(user_code);
    return json(toResp(data, history));
  } catch (err: any) {
    console.error('[account-status] GET fatal', err);
    return json({ error: 'サーバーエラー' }, { status: 500 });
  }
}
