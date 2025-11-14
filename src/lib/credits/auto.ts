// src/lib/credits/auto.ts
import { NextRequest } from 'next/server';
import { createClient } from '@supabase/supabase-js';

type AuthorizeResult =
  | { ok: true; status: number; data?: any }
  | {
      ok: false;
      status: number;
      error: string;
      data?: any;
      balance?: number;
      required?: number;
    };

type CaptureResult =
  | { ok: true; status: number; data?: any }
  | { ok: false; status: number; error: string; data?: any };

/** Iros用のref生成（会話ID＋UNIXms） */
export function makeIrosRef(conversationId: string, startedAtMs: number): string {
  return `iros:${conversationId}:${startedAtMs}`;
}

/** Supabase(service) クライアント */
function sbAdmin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

/** capture前プリチェック：不足なら authorize を呼ばずに即NGを返す */
async function precheckBalance(
  userCode: string,
  amount: number,
): Promise<{ ok: boolean; balance: number; required: number }> {
  const sb = sbAdmin();
  const { data, error } = await sb.rpc('check_user_balance_before_capture', {
    p_user_code: userCode,
    p_amount: amount,
  });

  if (error) {
    // プリチェック失敗は「通さない」ことで安全側に倒す（＝後段でauthorize失敗扱い）
    throw new Error(`credit_precheck_failed: ${error.message}`);
  }

  const row = Array.isArray(data) ? data[0] : data;
  const ok = !!row?.ok;
  const balance = Number(row?.current_balance ?? 0);
  const required = Number(row?.required_amount ?? amount);
  return { ok, balance, required };
}

/** authorize 呼び出し（不足時は 402を想定するが、ここでは構造のみ返す） */
export async function authorizeChat(
  req: NextRequest,
  userCode: string,
  amount: number,
  ref: string,
  refConv?: string,
): Promise<AuthorizeResult> {
  // 1) プリチェック
  try {
    const pre = await precheckBalance(userCode, amount);
    if (!pre.ok) {
      return {
        ok: false,
        status: 402,
        error: 'insufficient_credit',
        balance: pre.balance,
        required: pre.required,
        data: { precheck: true },
      };
    }
  } catch (e: any) {
    // プリチェック自体の異常は 500 として返す（上位で 500にするか402に丸めるかは任意）
    return { ok: false, status: 500, error: 'credit_precheck_failed', data: { message: e?.message } };
  }

  // 2) 内部APIへプロキシ
  const origin = new URL(req.url).origin;
  const url = `${origin}/api/credits/authorize`;
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  // Firebase Authorization を引き継ぎ
  const authz = req.headers.get('authorization');
  if (authz) headers['authorization'] = authz;

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ user_code: userCode, amount, ref, ref_conv: refConv }),
  });

  const json = await safeJson(res);
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      error: (json?.error as string) ?? 'authorize_failed',
      data: json,
    };
  }

  // 200 でもAPI設計上 {ok:false} の可能性があるため二重チェック
  if (json && typeof json === 'object' && json.ok === false) {
    return {
      ok: false,
      status: 200,
      error: (json?.error as string) ?? 'authorize_failed',
      data: json,
    };
  }

  return { ok: true, status: res.status, data: json };
}

/** capture 呼び出し（authorize成功後のみ使用） */
export async function captureChat(
  req: NextRequest,
  userCode: string,
  amount: number,
  ref: string,
): Promise<CaptureResult> {
  const origin = new URL(req.url).origin;
  const url = `${origin}/api/credits/capture`;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const authz = req.headers.get('authorization');
  if (authz) headers['authorization'] = authz;

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ user_code: userCode, amount, ref }),
  });

  const json = await safeJson(res);
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      error: (json?.error as string) ?? 'capture_failed',
      data: json,
    };
  }
  if (json && typeof json === 'object' && json.ok === false) {
    return { ok: false, status: 200, error: (json?.error as string) ?? 'capture_failed', data: json };
  }

  return { ok: true, status: res.status, data: json };
}

async function safeJson(res: Response) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}
