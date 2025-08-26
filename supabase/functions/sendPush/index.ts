// @ts-nocheck
import webpush from "npm:web-push@3.6.7";

const VAPID_PUBLIC_KEY = Deno.env.get("VAPID_PUBLIC_KEY")!;
const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY")!;
const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

function looksLikeUUID(v: string | undefined): boolean {
  if (!v) return false;
  // 簡易UUID v4 判定
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

  try {
    const { user_code, uid, title, body, url, tag } = await req.json();

    // 送信対象の取得: uid を最優先。無ければ user_code が UUID の場合のみ使用。
    let query = "";
    if (typeof uid === "string" && uid) {
      query = `uid=eq.${encodeURIComponent(uid)}`;
    } else if (typeof user_code === "string" && looksLikeUUID(user_code)) {
      // user_code が UUID 型カラムでも安全
      query = `user_code=eq.${encodeURIComponent(user_code)}`;
    } else {
      return new Response(
        JSON.stringify({ ok: false, reason: "require uid or uuid-like user_code" }),
        { status: 400 },
      );
    }

    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/push_subscriptions?${query}&select=endpoint,p256dh,auth`,
      { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` } }
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

        // 410/404 は自動削除（掃除）
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
