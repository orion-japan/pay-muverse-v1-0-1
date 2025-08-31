export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';

export async function DELETE(_req: Request, { params }: any) {
  const id: string = params?.id;

  // ← ここに既存の削除処理を戻してください
  // await deleteConversation(id);

  return NextResponse.json({ ok: true, id });
}
