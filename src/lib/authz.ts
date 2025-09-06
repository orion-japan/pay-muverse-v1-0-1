// src/lib/authz.ts
import { NextRequest } from 'next/server';
import { adminAuth } from '@/lib/firebase-admin';
import { createClient } from '@supabase/supabase-js';
import jwt from 'jsonwebtoken';

/* ===== 環境変数（既存名に対応）===== */
const _URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ||
  process.env.SUPABASE_URL?.trim();

const _SR =
  process.env.SUPABASE_SERVICE_ROLE?.trim() ||
  process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

const _JWT =
  process.env.SUPABASE_JWT_SECRET?.trim() ||
  process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

if (!_URL) throw new Error('ENV SUPABASE_URL/NEXT_PUBLIC_SUPABASE_URL is missing');
if (!_SR)  throw new Error('ENV SUPABASE_SERVICE_ROLE(_KEY) is missing');
if (!_JWT) throw new Error('ENV SUPABASE_JWT_SECRET or SUPABASE_SERVICE_ROLE_KEY is missing');

export const SUPABASE_URL  = _URL;
export const SERVICE_ROLE  = _SR;
export const POSTGREST_JWT = _JWT;

/* ===== 型（ルートとの互換最優先）===== */
export type AuthzResult = {
  ok: boolean;
  allowed: boolean;
  status: number;              // 200 / 401 / 403
  pgJwt: string | null;
  userCode: string | null;
  role: 'master' | 'admin' | 'other';
  error?: string;
  // ★ 追加: 既存ルート互換用（normalizeAuthz が拾う）
  user?: { uid: string; user_code: string } | null;
};

/* ===== PostgREST 用 JWT =====
   ※ sub は UUID である必要はなく、RLSで参照する「user_code」を入れる */
function signPostgresJwt(claims: { user_code: string; firebase_uid?: string }) {
  const payload = {
    sub: claims.user_code,         // ★ ここを user_code に
    role: 'authenticated',
    user_code: claims.user_code,   // RLSで使う
    firebase_uid: claims.firebase_uid ?? null,
    exp: Math.floor(Date.now() / 1000) + 15 * 60,
  } as const;
  return jwt.sign(payload, POSTGREST_JWT, { algorithm: 'HS256' });
}

/* ===== 本体（NextRequest でも string でも受ける）===== */
export async function verifyFirebaseAndAuthorize(input: NextRequest | string): Promise<AuthzResult> {
  // 1) ID トークン取得
  let idToken: string | null = null;
  if (typeof input === 'string') {
    idToken = input || null;
  } else {
    const authz = input.headers.get('authorization') || '';
    idToken = authz.startsWith('Bearer ') ? authz.slice(7) : null;
  }
  if (!idToken) {
    return { ok: false, allowed: false, status: 401, pgJwt: null, userCode: null, role: 'other', error: 'Missing Firebase ID token', user: null };
  }

  try {
    // 2) Firebase 検証（revocation考慮: true）
    const decoded = await adminAuth.verifyIdToken(idToken, true);
    const firebaseUid = decoded.uid;

    // 3) users から user_code / 権限取得（Service Role）
    const adminSb = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });
    const { data: u, error } = await adminSb
      .from('users')
      .select('user_code, click_type, plan_status')
      .eq('firebase_uid', firebaseUid)
      .maybeSingle();
    if (error) throw error;
    if (!u?.user_code) {
      return { ok: false, allowed: false, status: 401, pgJwt: null, userCode: null, role: 'other', error: 'user_code not found', user: null };
    }

    const role: 'master' | 'admin' | 'other' =
      (u.click_type === 'master' || u.plan_status === 'master') ? 'master' :
      (u.click_type === 'admin'  || u.plan_status === 'admin')  ? 'admin'  : 'other';

    // ★ 仕様変更ポイント：ここでは 403 にせず、常に allowed=true / status=200 を返す
    //   - ルート側で role を見てアクセス制御したい場合に備え、role は保持
    //   - これにより一般ユーザー（other）でも /api/q/unified などの参照APIは通せる

    const pgJwt = signPostgresJwt({ user_code: u.user_code, firebase_uid: firebaseUid });

    return {
      ok: true,
      allowed: true,
      status: 200,
      pgJwt,
      userCode: u.user_code,
      role,
      user: { uid: firebaseUid, user_code: u.user_code },
    };
  } catch (e: any) {
    console.error('[authz] error:', e);
    return { ok: false, allowed: false, status: 401, pgJwt: null, userCode: null, role: 'other', error: e?.message || 'Auth failed', user: null };
  }
}

// ===== 既存互換：型 & 正規化ヘルパ =====
export type AuthedUser = { uid: string; user_code: string };

// いろんな形で返ってきても吸収する正規化ヘルパ
export function normalizeAuthz(result: any): { user: AuthedUser | null; error: string | null } {
  // パターンA: { ok: true, user } | { ok: false, error: '...' }
  if (typeof result?.ok === 'boolean') {
    if (result.ok) {
      // 優先: 明示 user
      if (result.user && result.user.user_code) return { user: result.user as AuthedUser, error: null };
      // 互換: userCode → user に変換
      if (result.userCode) return { user: { uid: 'unknown', user_code: String(result.userCode) }, error: null };
      // 互換: user_code（スネークケース）も許容
      if (result.user_code) return { user: { uid: 'unknown', user_code: String(result.user_code) }, error: null };
      // ここまで来たら user 情報不足
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
