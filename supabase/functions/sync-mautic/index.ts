import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

const BASE = Deno.env.get("MAUTIC_BASE")!;
const CLIENT_ID = Deno.env.get("MAUTIC_CLIENT_ID")!;
const CLIENT_SECRET = Deno.env.get("MAUTIC_CLIENT_SECRET")!;

// 共通ヘッダ
const accept = { "Accept": "application/json" } as const;

async function getToken(): Promise<string> {
  const body = new URLSearchParams();
  body.append("grant_type", "client_credentials");
  body.append("client_id", CLIENT_ID);
  body.append("client_secret", CLIENT_SECRET);

  const url = `${BASE}/oauth/v2/token`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...accept },
    body,
  });
  if (!res.ok) throw new Error(`token ${res.status} ${await res.text()}`);
  const data = await res.json();
  if (!data?.access_token) throw new Error("token missing access_token");
  return data.access_token as string;
}

async function upsertContact(accessToken: string, fields: Record<string, unknown>) {
  if (!fields.email || String(fields.email).trim().length === 0) {
    throw new Error("email is required");
  }

  // --- 既存検索（Accept を明示）---
  const search = encodeURIComponent(`email:${fields.email}`);
  const findUrl = `${BASE}/api/contacts?search=${search}&limit=1`;
  const found = await fetch(findUrl, {
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}`, ...accept },
  });
  if (!found.ok) throw new Error(`search ${found.status} ${await found.text()}`);
  const data = await found.json();
  const existingId: string | null = Object.keys(data.contacts || {})[0] ?? null;

  const url = existingId
    ? `${BASE}/api/contacts/${existingId}/edit`
    : `${BASE}/api/contacts/new`;

  const res = await fetch(url, {
    method: existingId ? "PUT" : "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...accept,
    },
    body: JSON.stringify(fields),
  });

  if (!res.ok) throw new Error(`upsert ${res.status} ${await res.text()}`);
  return await res.json();
}

async function addToSegment(accessToken: string, cid: string, segId = 1) {
  const url = `${BASE}/api/segments/${segId}/contact/${cid}/add`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...accept,
    },
    body: "{}",
  });
  if (!res.ok) throw new Error(`segment ${res.status} ${await res.text()}`);
  return await res.json();
}

serve(async (req) => {
  try {
    const event = await req.json().catch(() => ({}));
    const r = event?.record ?? {};
    if (!r.email) {
      return new Response(JSON.stringify({ ok: false, error: "No email in payload" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // ログ（機微は出さない）
    console.log("sync-mautic received:", {
      type: event?.type ?? "unknown",
      table: event?.table ?? "unknown",
      email: r.email,
      user_code: r.user_code ?? null,
    });

    const token = await getToken();

    const fields = {
      email: String(r.email),
      external_id: r.user_code ?? undefined,
      firstname: r.first_name ?? "",
      lastname: r.last_name ?? "",
      credit_balance: typeof r.credit_balance === "number" ? r.credit_balance : 0,
      last_vision_at: r.last_vision_at ?? null, // ISO8601 文字列想定
    };

    const contact = await upsertContact(token, fields);
    const cid: string = contact?.contact?.id ?? contact?.id ?? null;
    if (!cid) throw new Error("upsert ok but no contact id in response");

    await addToSegment(token, cid, 1);

    console.log("sync-mautic success:", { cid });
    return new Response(JSON.stringify({ ok: true, cid }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("sync-mautic error:", msg);
    return new Response(JSON.stringify({ ok: false, error: msg }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
