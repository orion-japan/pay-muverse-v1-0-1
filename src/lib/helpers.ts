// Next.js 15+ cookies(): async への対応（型注釈を最小化して互換性を確保）
'use server';

import { cookies } from 'next/headers';

/** 読み取り */
export async function getItemAsync(name: string): Promise<string | null> {
  const store = await cookies();
  const v = store.get(name as any); // { name: string; value: string } | undefined
  return v?.value ?? null;
}

/** 設定 */
export async function setItemAsync(
  name: string,
  value: string,
  options?: {
    path?: string;
    domain?: string;
    httpOnly?: boolean;
    secure?: boolean;
    sameSite?: 'lax' | 'strict' | 'none';
    maxAge?: number;
    expires?: Date;
  },
): Promise<void> {
  const store = await cookies();
  store.set({
    name,
    value,
    path: options?.path ?? '/',
    domain: options?.domain,
    httpOnly: options?.httpOnly ?? true,
    secure: options?.secure ?? true,
    sameSite: options?.sameSite ?? 'lax',
    maxAge: options?.maxAge,
    expires: options?.expires,
  } as any);
}

/** 削除（実質 maxAge=0 で消す） */
export async function removeItemAsync(
  name: string,
  options?: { path?: string; domain?: string },
): Promise<void> {
  const store = await cookies();
  store.set({
    name,
    value: '',
    path: options?.path ?? '/',
    domain: options?.domain,
    maxAge: 0,
  } as any);
}
