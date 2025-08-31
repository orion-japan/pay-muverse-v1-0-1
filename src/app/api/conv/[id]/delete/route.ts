// src/app/api/conv/[id]/delete/route.ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';

// 型注釈は付けない（context は any 推論）
export async function DELETE(_req: Request, { params }: any) {
  const id: string = params?.id;

  // ここに元の削除処理を戻す
  // await deleteConversation(id);

  return NextResponse.json({ ok: true, id });
}
