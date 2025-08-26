// supabase/functions/sendPush/index.ts
// @ts-nocheck
import webpush from "npm:web-push@3.6.7";

const VAPID_PUBLIC_KEY = Deno.env.get("VAPID_PUBLIC_KEY")!;
const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY")!;
const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

  try {
    const input = await req.json();
    const { user_code, title, body, url, tag, image, icon, badge, renotify, vibration } = input || {};

    if (!user_code) {
      return new Response(JSON.stringify({ ok: false, reason: "missing user_code" }), { status: 400 });
    }

    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/push_subscriptions?user_code=eq.${encodeURIComponent(user_code)}&select=endpoint,p256dh,auth`,
      { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` } }
    );
    const subs = await res.json();

    if (!Array.isArray(subs) || subs.length === 0) {
      return new Response(JSON.stringify({ ok: false, reason: "no subscription for user_code" }), { status: 404 });
    }

    const payload = JSON.stringify({
      title: title ?? "Muverse",
      body: body ?? "",
      url: url ?? "/",
      tag: tag ?? "muverse",
      image: image ?? undefined,
      icon: icon ?? undefined,
      badge: badge ?? undefined,
      renotify: !!renotify,
      vibration: Array.isArray(vibration) ? vibration : undefined,
    });

    const results: any[] = [];
    for (const s of subs) {
      try {
        const r = await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          payload,
          { TTL: 600 }
        );
        results.push({ endpoint: s.endpoint, status: "fulfilled", statusCode: r?.statusCode ?? 201 });
      } catch (e) {
        const statusCode = e?.statusCode ?? null;
        const errBody = e?.body ? String(e.body) : String(e?.message ?? e);
        results.push({ endpoint: s.endpoint, status: "rejected", statusCode, error: errBody });

        if (statusCode === 404 || statusCode === 410) {
          try {
            await fetch(`${SUPABASE_URL}/rest/v1/push_subscriptions?endpoint=eq.${encodeURIComponent(s.endpoint)}`, {
              method: "DELETE",
              headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
            });
          } catch {}
        }
      }
    }

    return new Response(JSON.stringify({ ok: true, results }), { status: 200 });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), { status: 500 });
  }
});
