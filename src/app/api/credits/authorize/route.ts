// src/app/api/credits/authorize/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { adminClient } from '@/lib/credits/db';
import { randomUUID } from 'crypto';

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({} as any));
    // 型の吸収（number でも string でもOKに）
    let user_code_raw = body?.user_code;
    const amount_raw = body?.amount;
    const ref = String(body?.ref ?? '');

    const user_code = user_code_raw != null ? String(user_code_raw).trim() : '';
    const amount = Number(amount_raw);

    // 共有シークレットがある場合のみチェック（無ければスルー）
    const shared = req.headers.get('x-shared-secret') || req.headers.get('authorization')?.replace(/^Bearer\s+/i,'') || '';
    const NEED_SECRET = !!process.env.CREDITS_SHARED_SECRET;
    if (NEED_SECRET && shared !== process.env.CREDITS_SHARED_SECRET) {
      return new Response(JSON.stringify({ ok:false, error:'forbidden' }), { status: 403 });
    }

    if (!user_code || !Number.isFinite(amount) || amount <= 0 || !ref) {
      return new Response(JSON.stringify({ ok:false, error:'bad_request' }), { status: 400 });
    }

    // ここで users.sofia_credit の残高確認 → OKなら仮押さえ（台帳に pending 等）
    // 例：
    // const ok = await holdCredit({ user_code, amount, ref });
    const ok = true; // まずは通す（台帳実装は後でもOK）

    if (!ok) return new Response(JSON.stringify({ ok:false, error:'insufficient_credit' }), { status: 402 });
    return new Response(JSON.stringify({ ok:true }), { status: 200 });
  } catch (e:any) {
    return new Response(JSON.stringify({ ok:false, error:String(e?.message||'error') }), { status: 500 });
  }
}
