// src/app/api/agent/iros/seed/route.ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { verifyFirebaseAndAuthorize } from '@/lib/authz';
import { generateIrosReply } from '@/lib/iros/generate';

/**
 * Iros 未来Seed（β）API
 * - 認証済みユーザー専用
 * - 入力テキストをもとに「T層モード」で Iros に未来Seedを生成させる
 * - まだ会話ログには保存せず、プレビュー的な位置づけ
 */




export async function POST(req: NextRequest) {
  return NextResponse.json(
    { ok: false, error: 'disabled', detail: 'seed route is currently not in use' },
    { status: 404 },
  );
  try {
    // ---- 認証 ----
    const auth = await verifyFirebaseAndAuthorize(req as any);
    if (!auth?.ok) {
      return NextResponse.json(
        { ok: false, error: auth?.error || 'unauthorized' },
        { status: auth?.status || 401 },
      );
    }
    if (!auth.allowed) {
      return NextResponse.json(
        { ok: false, error: 'forbidden' },
        { status: 403 },
      );
    }

    const body = await req.json().catch(() => ({}));
    const rawText = body?.text ?? body?.message ?? '';

    const text: string = String(rawText || '').trim();
    if (!text) {
      return NextResponse.json(
        { ok: false, error: 'empty' },
        { status: 400 },
      );
    }

    const user_code: string | null =
      (body.user_code as string | undefined) ??
      auth.userCode ??
      (auth.user as any)?.user_code ??
      null;

    if (!user_code) {
      return NextResponse.json(
        { ok: false, error: 'no_user_code' },
        { status: 401 },
      );
    }

    // 会話IDは暫定で user_code ベース
    const conversationId: string =
      String(body.conversation_id || body.cid || '') ||
      `iros-seed-${user_code}`;

    // ---- Iros 未来Seed 生成 ----
    const meta: any = {
      // 通常の Iros と区別したいとき用のフラグ
      mode: 'seed',
      tLayerModeActive: true,
      tLayerHint: 'future_seed',
      user_code,
    };

    const out = await generateIrosReply({
      text,
      meta,
      conversationId,
      history: [], // 未来Seed専用なので、まずは履歴なしのシンプル版
    });

    return NextResponse.json(
      {
        ok: true,
        route: 'api/agent/iros/seed',
        agent: 'iros',
        conversation_id: conversationId,
        reply: out.content,
        meta: out.intent ?? null,
      },
      { status: 200 },
    );
  } catch (e: any) {
    console.error('[iros/seed] error:', e);
    return NextResponse.json(
      {
        ok: false,
        error: 'internal_error',
        detail: String(e?.message || e),
      },
      { status: 500 },
    );
  }
}
