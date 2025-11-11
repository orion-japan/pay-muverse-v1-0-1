// src/lib/authz.ts
import type { NextRequest } from 'next/server';
import { adminAuth } from '@/lib/firebase-admin';
import { createClient } from '@supabase/supabase-js';
import jwt from 'jsonwebtoken';

/* ===== 環境変数（既存名に対応）===== */
const _URL = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || process.env.SUPABASE_URL?.trim();

const _SR =
  process.env.SUPABASE_SERVICE_ROLE?.trim() || process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

const _JWT =
  process.env.SUPABASE_JWT_SECRET?.trim() || process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

if (!_URL) throw new Error('ENV SUPABASE_URL/NEXT_PUBLIC_SUPABASE_URL is missing');
if (!_SR) throw new Error('ENV SUPABASE_SERVICE_ROLE(_KEY) is missing');
if (!_JWT) throw new Error('ENV SUPABASE_JWT_SECRET or SUPABASE_SERVICE_ROLE_KEY is missing');

export const SUPABASE_URL = _URL;
export const SERVICE_ROLE = _SR;
export const POSTGREST_JWT = _JWT;

/* ===== 型（ルートとの互換最優先）===== */
export type AuthzResult = {
  ok: boolean;
  allowed: boolean;
  status: number; // 200 / 401 / 403
  pgJwt: string | null;
  userCode: string | null;
  role: 'master' | 'admin' | 'other';
  error?: string;
  uid: string | null; // 追加（利用側の互換のため）
  user?: { uid: string; user_code: string } | null;
};

/* ===== ログ補助 ===== */
const NS = '[authz]';
const rid = () =>
  (globalThis as any).crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
const log = (id: string, ...a: any[]) => console.log(NS, id, ...a);
const warn = (id: string, ...a: any[]) => console.warn(NS, id, ...a);
const err = (id: string, ...a: any[]) => console.error(NS, id, ...a);

/* ===== Cookie ユーティリティ ===== */
function parseCookies(header: string | null) {
  const out: Record<string, string> = {};
  if (!header) return out;
  header.split(';').forEach((p) => {
    const [k, ...v] = p.trim().split('=');
    out[k] = decodeURIComponent(v.join('=') || '');
  });
  return out;
}

/* ===== PostgREST 用 JWT =====
   ※ sub は UUID である必要はなく、RLSで参照する「user_code」を入れる */
function signPostgresJwt(claims: { user_code: string; firebase_uid?: string }) {
  const payload = {
    sub: claims.user_code, // ← user_code を主体IDに
    role: 'authenticated',
    user_code: claims.user_code, // RLSで参照
    firebase_uid: claims.firebase_uid ?? null,
    exp: Math.floor(Date.now() / 1000) + 15 * 60, // 15分
  } as const;
  return jwt.sign(payload, POSTGREST_JWT, { algorithm: 'HS256' });
}

/* ===== 本体：Bearer or Cookie どちらでもOK =====
   - input: NextRequest | Request | string(Bearerトークン直渡し)
*/
export async function verifyFirebaseAndAuthorize(
  input: NextRequest | Request | string,
): Promise<AuthzResult> {
  const id = rid();
  const t0 = Date.now();
  const path = typeof input === 'string' ? 'bearer:string' : ((input as any)?.url ?? 'unknown');
  log(id, 'start', { path });

  let bearerToken: string | null = null;
  let sessionCookie: string | null = null;

  // 開発用：user_code をヘッダ/クエリから拾う（Firebaseなしフォールバック）
  const isDev = process.env.NODE_ENV !== 'production';
  let devUserCode: string | null = null;
  let urlUserCode: string | null = null;

  if (typeof input === 'string') {
    bearerToken = input || null;
  } else {
    const authz = input.headers.get('authorization') || input.headers.get('Authorization') || '';
    bearerToken = authz.startsWith('Bearer ') ? authz.slice(7).trim() : null;

    // Cookie も見る（__session = Firebase Session Cookie）
    const cookies = parseCookies(input.headers.get('cookie'));
    sessionCookie = cookies.__session || null;

    // ← 開発フォールバック用の user_code 取得（ヘッダとURLクエリ）
    devUserCode = input.headers.get('x-user-code') || input.headers.get('x-mu-user') || null;

    try {
      const u = new URL((input as any).url);
      urlUserCode = u.searchParams.get('user_code');
    } catch {}
  }

  // 開発簡易トークン: Authorization: Bearer dev:<user_code>
  if (isDev && bearerToken && bearerToken.startsWith('dev:')) {
    const user = bearerToken.slice('dev:'.length).trim();
    if (user) {
      const pgJwt = signPostgresJwt({ user_code: user });
      const ms = Date.now() - t0;
      log(id, 'dev-bearer ok', { user, role: 'admin', ms });
      return {
        ok: true,
        allowed: true,
        status: 200,
        pgJwt,
        userCode: user,
        role: 'admin',
        user: { uid: 'dev-bearer', user_code: user },
        uid: 'dev-bearer',
      };
    }
  }

  if (!bearerToken && !sessionCookie) {
    // ★ 開発用フォールバック（Firebaseなしで通す）
    const fallbackCode = (devUserCode || urlUserCode || '').trim();
    if (isDev && fallbackCode) {
      const pgJwt = signPostgresJwt({ user_code: fallbackCode });
      const ms = Date.now() - t0;
      log(id, 'dev-fallback ok', { user: fallbackCode, role: 'admin', ms });
      return {
        ok: true,
        allowed: true,
        status: 200,
        pgJwt,
        userCode: fallbackCode,
        role: 'admin',
        user: { uid: 'dev-fallback', user_code: fallbackCode },
        uid: 'dev-fallback',
      };
    }

    // 本番 or user_code 不在 → 401
    warn(id, 'no credentials');
    return {
      ok: false,
      allowed: false,
      status: 401,
      pgJwt: null,
      userCode: null,
      role: 'other',
      error: 'Missing credentials (Bearer or __session cookie)',
      user: null,
      uid: null,
    };
  }

  try {
    // 1) Firebase 検証（Bearer優先。無ければ SessionCookie）
    let firebaseUid: string;
    console.time(`${NS} ${id} verify firebase`);
    if (bearerToken) {
      const dec = await adminAuth.verifyIdToken(bearerToken, true);
      firebaseUid = dec.uid;
    } else {
      const dec = await adminAuth.verifySessionCookie(sessionCookie!, true);
      firebaseUid = dec.uid;
    }
    console.timeEnd(`${NS} ${id} verify firebase`);

    // 2) users から user_code / 権限取得（Service Role）
    const adminSb = createClient(SUPABASE_URL, SERVICE_ROLE, {
      auth: { persistSession: false },
    });

    console.time(`${NS} ${id} fetch user`);
    // ※ ご利用のスキーマに合わせて 'firebase_uid' を変更してください
    const { data: u, error } = await adminSb
      .from('users')
      .select('user_code, click_type, plan_status')
      .eq('firebase_uid', firebaseUid)
      .maybeSingle();
    console.timeEnd(`${NS} ${id} fetch user`);

    if (error) throw error;
    if (!u?.user_code) {
      warn(id, 'user_code not found', { uid: firebaseUid });
      return {
        ok: false,
        allowed: false,
        status: 401,
        pgJwt: null,
        userCode: null,
        role: 'other',
        error: 'user_code not found',
        user: null,
        uid: null,
      };
    }

    const role: 'master' | 'admin' | 'other' =
      (u as any).click_type === 'master' || (u as any).plan_status === 'master'
        ? 'master'
        : (u as any).click_type === 'admin' || (u as any).plan_status === 'admin'
          ? 'admin'
          : 'other';

    // 3) PostgREST/JWT（RLSで使う）
    const pgJwt = signPostgresJwt({ user_code: u.user_code, firebase_uid: firebaseUid });

    const ms = Date.now() - t0;
    log(id, 'ok', { user: u.user_code, role, ms });

    return {
      ok: true,
      allowed: true,
      status: 200,
      pgJwt,
      userCode: u.user_code,
      role,
      user: { uid: firebaseUid, user_code: u.user_code },
      uid: firebaseUid,
    };
  } catch (e: any) {
    const ms = Date.now() - t0;
    err(id, 'error', { message: e?.message, ms });
    return {
      ok: false,
      allowed: false,
      status: 401,
      pgJwt: null,
      userCode: null,
      role: 'other',
      error: e?.message || 'Auth failed',
      user: null,
      uid: null,
    };
  }
}

/* ===== 既存互換：型 & 正規化ヘルパ ===== */
export type AuthedUser = { uid: string; user_code: string };

export function normalizeAuthz(result: any): { user: AuthedUser | null; error: string | null } {
  // パターンA: { ok: true/false, ... }
  if (typeof result?.ok === 'boolean') {
    if (result.ok) {
      if (result.user && result.user.user_code)
        return { user: result.user as AuthedUser, error: null };
      if (result.userCode)
        return { user: { uid: 'unknown', user_code: String(result.userCode) }, error: null };
      if (result.user_code)
        return { user: { uid: 'unknown', user_code: String(result.user_code) }, error: null };
      return { user: null, error: 'Authorized but no user info' };
    }
    return { user: null, error: String(result.error ?? 'Unauthorized') };
  }

  // パターンB: { user, error? }
  if (result?.user) return { user: result.user as AuthedUser, error: null };
  if (result?.error) return { user: null, error: String(result.error) };

  // パターンC: user を直接返す
  if (result && typeof result === 'object' && ('user_code' in result || 'userCode' in result)) {
    const code = (result as any).user_code ?? (result as any).userCode;
    return { user: { uid: 'unknown', user_code: String(code) }, error: null };
  }

  return { user: null, error: 'Unauthorized' };
}
