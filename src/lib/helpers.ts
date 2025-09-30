// src/lib/helpers.ts

import { cookies, headers } from 'next/headers';

/**
 * Dynamic API 互換：Cookie を await で取得して値を返す。
 * 例) const token = await getItemAsync('sb-xxx-auth-token.0')
 */
export async function getItemAsync(name: string): Promise<string | null> {
  const jar = await cookies(); // ← Dynamic API では await が必須
  return jar.get(name)?.value ?? null;
}

/**
 * Cookie をまとめて取得（必要なら）。
 * 返り値は key: value の素朴なオブジェクト。
 */
export async function getAllCookiesAsync(): Promise<Record<string, string>> {
  const jar = await cookies();
  const out: Record<string, string> = {};
  jar.getAll().forEach((c) => (out[c.name] = c.value));
  return out;
}

/**
 * Authorization ヘッダから Bearer トークンを取り出すユーティリティ。
 * 例) const idToken = await getBearerTokenAsync()
 */
export async function getBearerTokenAsync(): Promise<string | null> {
  const h = await headers();
  const auth =
    h.get('authorization') ||
    h.get('Authorization') ||
    '';
  if (!auth.startsWith('Bearer ')) return null;
  return auth.slice(7).trim() || null;
}

/**
 * Bearer が無ければ __session Cookie を見るユーティリティ。
 * Firebase のサーバーサイド検証前の「候補」取得に使えます。
 */
export async function getAuthCandidateAsync(): Promise<{
  bearer: string | null;
  session: string | null;
}> {
  const bearer = await getBearerTokenAsync();
  const session = await getItemAsync('__session');
  return { bearer, session };
}
