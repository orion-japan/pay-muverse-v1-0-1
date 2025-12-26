// src/lib/authz.ts
import type { NextRequest } from 'next/server';
import { adminAuth } from '@/lib/firebase-admin';
import { createClient } from '@supabase/supabase-js';
import jwt from 'jsonwebtoken';

/* ===== 環境変数（既存名に対応）===== */
const _URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ??
  process.env.SUPABASE_URL?.trim() ??
  '';

const _SR =
  process.env.SUPABASE_SERVICE_ROLE?.trim() ??
  process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ??
  '';

const _JWT =
  process.env.SUPABASE_JWT_SECRET?.trim() ??
  process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ??
  '';

if (!_URL) throw new Error('ENV SUPABASE_URL/NEXT_PUBLIC_SUPABASE_URL is missing');
if (!_SR) throw new Error('ENV SUPABASE_SERVICE_ROLE(_KEY) is missing');
if (!_JWT) throw new Error('ENV SUPABASE_JWT_SECRET or SUPABASE_SERVICE_ROLE_KEY is missing');

export const SUPABASE_URL: string = _URL;
export const SERVICE_ROLE: string = _SR;
// ★ jwt.Secret として型を確定（undefined を排除）
export const POSTGREST_JWT: jwt.Secret = _JWT;

/* ===== 型（ルートとの互換最優先）===== */
export type AuthzResult = {
  ok: boolean;
  allowed: boolean;
  status: number; // 200 / 401 / 403
  pgJwt: string | null;
  userCode: string | null;
  role: 'master' | 'admin' | 'other';
  error?: string;
  uid: string | null;
  user?: { uid: string; user_code: string } | null;
};

/* ===== ログ補助 ===== */
const NS = '[authz]';
const rid = () =>
  (globalThis as any).crypto?.randomUUID?.() ??
  Math.random().toString(36).slice(2);
const log = (id: string, ...a: unknown[]) => console.log(NS, id, ...a);
const warn = (id: string, ...a: unknown[]) => console.warn(NS, id, ...a);
const err = (id: string, ...a: unknown[]) => console.error(NS, id, ...a);

/* ===== Cookie ユーティリティ ===== */
function parseCookies(header: string | null) {
  const out: Record<string, string> = {};
  if (!header) return out;
  header.split(';').forEach((p) => {
    const [k, ...v] = p.trim().split('=');
    if (!k) return;
    out[k] = decodeURIComponent(v.join('=') || '');
  });
  return out;
}

/* ===== PostgREST 用 JWT ===== */
function signPostgresJwt(claims: { user_code: string; firebase_uid?: string }) {
  const payload = {
    sub: claims.user_code,
    role: 'authenticated',
    user_code: claims.user_code,
    firebase_uid: claims.firebase_uid ?? null,
    exp: Math.floor(Date.now() / 1000) + 15 * 60,
  } as const;

  return jwt.sign(payload, POSTGREST_JWT, { algorithm: 'HS256' });
}

/* ===== 本体：Firebase 検証 + RLS 用 JWT ===== */
export async function verifyFirebaseAndAuthorize(
  input: NextRequest | Request | string,
): Promise<AuthzResult> {
  const id = rid();
  const t0 = Date.now();
  const path =
    typeof input === 'string' ? 'bearer:string' : ((input as any)?.url ?? 'unknown');
  log(id, 'start', { path });

  let bearerToken: string | null = null;
  let sessionCookie: string | null = null;

  const isDev = process.env.NODE_ENV !== 'production';
  let devUserCode: string | null = null;
  let urlUserCode: string | null = null;

  if (typeof input === 'string') {
    bearerToken = input || null;
  } else {
    const authz =
      input.headers.get('authorization') ||
      input.headers.get('Authorization') ||
      '';
    bearerToken = authz.startsWith('Bearer ')
      ? authz.slice(7).trim()
      : null;
// --- TEMP DEBUG (remove later) ---
const authzLen = authz.length;
const authzHead = authz.slice(0, 24);
console.log('[authz][debug] header', { authzLen, authzHead });
// --- TEMP DEBUG (remove later) ---

    const cookies = parseCookies(input.headers.get('cookie'));
    sessionCookie = cookies.__session || null;

    devUserCode =
      input.headers.get('x-user-code') ||
      input.headers.get('x-mu-user') ||
      null;

    try {
      const u = new URL((input as any).url);
      urlUserCode = u.searchParams.get('user_code');
    } catch {
      /* noop */
    }
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
    // 1) Firebase 検証
    let firebaseUid: string;
    let claimRole: string | undefined;
    let claimUserCode: string | undefined;
    let provider: string | undefined;

    const isTimeoutLike = (e: any) => {
      const msg = String(e?.message ?? e ?? '');
      return msg.includes('timeout') || msg.includes('ETIMEDOUT') || msg.includes('Deadline');
    };

    const verifyIdTokenWithFallback = async (token: string) => {
      try {
        return await adminAuth.verifyIdToken(token, true); // checkRevoked = true
      } catch (e) {
        // タイムアウト等のときだけ、失効チェックなしで救済
        if (isTimeoutLike(e)) {
          warn(id, 'verifyIdToken timeout -> retry without revoked-check');
          return await adminAuth.verifyIdToken(token, false);
        }
        throw e;
      }
    };

    const verifySessionCookieWithFallback = async (cookie: string) => {
      try {
        return await adminAuth.verifySessionCookie(cookie, true); // checkRevoked = true
      } catch (e) {
        if (isTimeoutLike(e)) {
          warn(id, 'verifySessionCookie timeout -> retry without revoked-check');
          return await adminAuth.verifySessionCookie(cookie, false);
        }
        throw e;
      }
    };

    console.time(`${NS} ${id} verify firebase`);
    const dec = bearerToken
      ? await verifyIdTokenWithFallback(bearerToken)
      : await verifySessionCookieWithFallback(sessionCookie!);

    firebaseUid = dec.uid;
    claimRole = (dec as any).role;
    claimUserCode = (dec as any).user_code;
    provider = (dec as any)?.firebase?.sign_in_provider;
    console.timeEnd(`${NS} ${id} verify firebase`);


    // 2) claims 優先で user_code / role を決定
    let finalUserCode: string | null = claimUserCode ?? null;
    let finalRole: 'master' | 'admin' | 'other' = 'other';

    if (typeof claimRole === 'string') {
      const cr = claimRole.toLowerCase();
      if (cr === 'master') finalRole = 'master';
      else if (cr === 'admin') finalRole = 'admin';
      else finalRole = 'other';
    }

    const isCustom = provider === 'custom';

    // 3) claims に user_code が無い場合のみ DB で補完
    let dbUserCode: string | null = null;
    let dbDerivedRole: 'master' | 'admin' | 'other' | null = null;

    if (!finalUserCode) {
      const adminSb = createClient(SUPABASE_URL, SERVICE_ROLE, {
        auth: { persistSession: false },
      });

      console.time(`${NS} ${id} fetch user`);
      const { data: u, error } = await adminSb
        .from('users')
        .select('user_code, click_type, plan_status')
        .eq('firebase_uid', firebaseUid)
        .maybeSingle();
      console.timeEnd(`${NS} ${id} fetch user`);

      if (error) throw error;
      if (u?.user_code) {
        dbUserCode = u.user_code;
        dbDerivedRole =
          (u as any).click_type === 'master' || (u as any).plan_status === 'master'
            ? 'master'
            : (u as any).click_type === 'admin' || (u as any).plan_status === 'admin'
              ? 'admin'
              : 'other';
      }
    }

    finalUserCode = finalUserCode ?? dbUserCode;

    if (finalRole === 'other' && dbDerivedRole) {
      finalRole = dbDerivedRole;
    }

    if (!finalUserCode && isCustom && claimUserCode) {
      finalUserCode = claimUserCode;
    }

    if (!finalUserCode) {
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

    // 4) PostgREST / JWT
    const pgJwt = signPostgresJwt({
      user_code: finalUserCode,
      firebase_uid: firebaseUid,
    });

    const ms = Date.now() - t0;
    log(id, 'ok', { user: finalUserCode, role: finalRole, provider, ms });

    return {
      ok: true,
      allowed: true,
      status: 200,
      pgJwt,
      userCode: finalUserCode,
      role: finalRole,
      user: { uid: firebaseUid, user_code: finalUserCode },
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

export function normalizeAuthz(
  result: unknown,
): { user: AuthedUser | null; error: string | null } {
  const r: any = result;

  if (typeof r?.ok === 'boolean') {
    if (r.ok) {
      if (r.user && r.user.user_code) {
        return { user: r.user as AuthedUser, error: null };
      }
      if (r.userCode) {
        return {
          user: { uid: 'unknown', user_code: String(r.userCode) },
          error: null,
        };
      }
      if (r.user_code) {
        return {
          user: { uid: 'unknown', user_code: String(r.user_code) },
          error: null,
        };
      }
      return { user: null, error: 'Authorized but no user info' };
    }
    return { user: null, error: String(r.error ?? 'Unauthorized') };
  }

  if (r?.user) return { user: r.user as AuthedUser, error: null };
  if (r?.error) return { user: null, error: String(r.error) };

  if (r && typeof r === 'object' && ('user_code' in r || 'userCode' in r)) {
    const code = (r as any).user_code ?? (r as any).userCode;
    return { user: { uid: 'unknown', user_code: String(code) }, error: null };
  }

  return { user: null, error: 'Unauthorized' };
}
