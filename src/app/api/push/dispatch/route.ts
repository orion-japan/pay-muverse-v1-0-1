// src/app/api/push/dispatch/route.ts
import { NextRequest, NextResponse } from 'next/server';

export async function POST(req: NextRequest) {
  try {
    const { subscriptions, payload } = await req.json();

    // 環境変数確認
    const edgeUrl = process.env.SENDPUSH_EDGE_URL;
    if (!edgeUrl) {
      console.error('SENDPUSH_EDGE_URL is undefined');
      return NextResponse.json({ error: 'SENDPUSH_EDGE_URL is undefined' }, { status: 500 });
    }
    console.log('EDGE URL:', edgeUrl);

    const resp = await fetch(edgeUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscriptions, payload }),
    });

    const text = await resp.text();
    console.log('Edge Response:', resp.status, text);

    return new NextResponse(text, {
      status: resp.status,
      headers: { 'Content-Type': resp.headers.get('content-type') || 'application/json' },
    });
  } catch (e: any) {
    console.error('Dispatch Error:', e);
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
