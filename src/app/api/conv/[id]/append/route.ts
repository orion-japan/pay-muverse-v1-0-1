// src/app/api/conv/[id]/append/route.ts
export const runtime = 'nodejs'; // 必要なら維持/追加
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';

type Ctx = {
  params: Record<string, string | string[]>;
};

// string | string[] を安全に取り出す小ヘルパ
function pickParam(v: string | string[] | undefined, name: string): string {
  if (v == null) throw new Error(`Missing route param: ${name}`);
  return Array.isArray(v) ? v[0] : v;
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const id = pickParam(ctx.params.id, 'id');

  // 必要ならボディ取得
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    body = undefined;
  }

  // ← ここに既存の処理をそのまま残してください
  // 例）会話への追記処理など
  // await appendConversation(id, body, ...)

  return NextResponse.json({ ok: true, id });
}
