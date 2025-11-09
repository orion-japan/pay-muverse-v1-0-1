import { NextRequest, NextResponse } from 'next/server';
import { rpcVoid } from '@/lib/credits/rpc';

export async function POST(req: NextRequest) {
  const { user_code, amount, ref } = await req.json();
  const ok = await rpcVoid(String(user_code), Number(amount), String(ref));
  return NextResponse.json({ ok }, { status: ok ? 200 : 200 }); // 冪等成功扱い
}
