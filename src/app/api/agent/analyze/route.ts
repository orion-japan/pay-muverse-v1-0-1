// src/app/api/agent/iros/analyze/route.ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';

const json = (data: any, status = 200) =>
  new NextResponse(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, Cookie',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
    },
  });

export async function OPTIONS() {
  return json({ ok: true });
}

/**
 * フロント互換のためのフォワーダー。
 * 受け取ったリクエストを /api/agent/iros にそのまま転送し、
 * 返信（保存・タイトル更新・メッセージ挿入を含む）をそのまま返す。
 */
export async function POST(req: NextRequest) {
  try {
    const origin = new URL(req.url).origin;
    const bodyText = await req.text(); // ボディを生で取得（再利用できるように）
    const headers = new Headers({
      'content-type': 'application/json',
    });

    // 認証系はそのまま引き継ぐ（Firebase/JWT/Cookie）
    const authz = req.headers.get('authorization');
    if (authz) headers.set('authorization', authz);
    const cookie = req.headers.get('cookie');
    if (cookie) headers.set('cookie', cookie);

    const r = await fetch(`${origin}/api/agent/iros`, {
      method: 'POST',
      headers,
      body: bodyText,
      // Next内部フェッチ最適化OFF（権限やヘッダを確実に渡すため）
      cache: 'no-store',
    });

    const text = await r.text();
    return new NextResponse(text, {
      status: r.status,
      headers: {
        'Content-Type': r.headers.get('content-type') || 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (e: any) {
    return json({ ok: false, error: 'forward_failed', detail: String(e?.message ?? e) }, 500);
  }
}
