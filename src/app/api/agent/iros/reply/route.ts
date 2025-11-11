// src/app/api/agent/iros/reply/route.ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import generate from '@/lib/iros/generate';
import { HINT_COUNSEL, HINT_STRUCTURED, HINT_DIAGNOSIS } from '@/lib/iros/hints';

// 共通CORSヘッダ（curl動作安定用）
const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'Content-Type, Authorization',
} as const;

function json(data: any, init?: number | ResponseInit) {
  const status =
    typeof init === 'number' ? init : ((init as ResponseInit | undefined)?.['status'] ?? 200);
  const headers = new Headers(
    typeof init === 'number' ? undefined : (init as ResponseInit | undefined)?.headers,
  );
  headers.set('Content-Type', 'application/json; charset=utf-8');
  // CORS 付与
  Object.entries(CORS_HEADERS).forEach(([k, v]) => headers.set(k, v));
  return new NextResponse(JSON.stringify(data), { status, headers });
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const conversationId: string | undefined = body?.conversationId;
    const text: string | undefined = body?.text;
    const modeHintReq: string | undefined = body?.modeHint;
    const extra = body?.extra ?? null;

    if (!conversationId || !text) {
      return json({ ok: false, error: 'bad_request', mode: 'auto' }, 400);
    }

    // 🧭 リクエストの modeHint → 定義済みヒント文へ正規化
    // generate() 側で system に挿入される前提（未対応でも無害）
    let resolvedHint = '';
    switch (String(modeHintReq ?? '').toLowerCase()) {
      case 'counsel':
        resolvedHint = HINT_COUNSEL;
        break;
      case 'structured':
        resolvedHint = HINT_STRUCTURED;
        break;
      case 'diagnosis':
      case 'ir':
      case 'ir_diagnosis':
        resolvedHint = HINT_DIAGNOSIS;
        break;
      default:
        resolvedHint = ''; // 指定なし → 自動判定に委ねる
    }

    // ユーザーコード（バイパスがあればそれを使用）
    const userCode =
      process.env.IROS_AUTH_BYPASS === '1'
        ? process.env.IROS_AUTH_BYPASS_USER || 'debug'
        : 'unknown';

        const result = await generate({
          conversationId,
          text,
          extra: {
            ...(extra ?? {}),
            hintText: resolvedHint,
            userCode,            // ← userCode は meta 用に extra に載せる
          },
        });


    // 🔒 mode フォールバック（null/undefined を許さない）
    const mode =
      (result && typeof result.mode === 'string' && result.mode.trim()) || 'auto';

    return json({
      ok: true,
      mode,
      assistant: result.text,
      title: result.title ?? null,
      meta: result.meta ?? null,
      via: 'orchestrator',
      bypass: process.env.IROS_AUTH_BYPASS === '1',
    });
  } catch (e: any) {
    return json(
      {
        ok: false,
        error: e?.message ?? 'internal_error',
        mode: 'auto', // 失敗時も必ず文字列を返す
      },
      500,
    );
  }
}
