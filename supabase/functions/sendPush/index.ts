// @ts-nocheck
// Deno 環境で実行（Supabase Edge Functions）
/// <reference lib="deno.ns" />
import webpush from "npm:web-push@3.6.7";

const VAPID_PUBLIC_KEY = Deno.env.get("VAPID_PUBLIC_KEY")!;
const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY")!;
const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

Deno.serve(async (req) => {
  try {
    if (req.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }
    const { user_code, title, body, url, tag } = await req.json();

    // 購読取得（REST）
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/push_subscriptions?user_code=eq.${encodeURIComponent(
        user_code
      )}&select=endpoint,p256dh,auth`,
      {
        headers: {
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        },
      }
    );
    const subs = await res.json();
    if (!Array.isArray(subs) || subs.length === 0) {
      return new Response(JSON.stringify({ ok: false, reason: "no subscription" }), { status: 404 });
    }

    const payload = JSON.stringify({
      title: title ?? "Muverse",
      body: body ?? "",
      url: url ?? "/",
      tag: tag ?? "muverse",
    });

    const results = await Promise.allSettled(
      subs.map((s: any) =>
        webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          payload,
          { TTL: 600 }
        )
      )
    );

    // 404/410 を検出して購読削除したい場合はここでREST呼び出し（任意）

    return new Response(JSON.stringify({ ok: true, results }), { status: 200 });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500 });
  }
});
