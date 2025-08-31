// src/app/api/conv/[id]/delete/route.ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

// Next.js 15: context.params は Promise
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // ← ここに既存の削除処理を戻してください
  // 例) await deleteConversation(id);

  return NextResponse.json({ ok: true, id });
}
