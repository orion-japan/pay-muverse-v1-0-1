import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  try {
    const { subscriptions, payload } = await req.json();

    const edgeUrl = process.env.SENDPUSH_EDGE_URL!;
    const apiKey = process.env.SUPABASE_SERVICE_ROLE_KEY!; // Service Role Key

    // 先頭だけ取る（Edge Function は単一 subscription を期待している）
    const subscription = Array.isArray(subscriptions) ? subscriptions[0] : subscriptions;

    const resp = await fetch(edgeUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
        "apikey": apiKey,
      },
      body: JSON.stringify({
        project: "hcodeoathneftqkmjyoh",  // Supabase プロジェクト REF
        subscription,
        payload,
      }),
    });

    const text = await resp.text();
    return new NextResponse(text, {
      status: resp.status,
      headers: {
        "Content-Type": resp.headers.get("content-type") || "application/json",
      },
    });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
