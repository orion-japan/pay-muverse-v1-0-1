// @ts-nocheck
// deno-lint-ignore-file

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
// supabase/functions/sync-mautic/index.ts
import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SB_URL  = Deno.env.get('SUPABASE_URL')!;
const SB_KEY  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!; // SR 必須
const MAUTIC  = Deno.env.get('MAUTIC_BASE')!.replace(/\/+$/, '');
const M_ID    = Deno.env.get('MAUTIC_CLIENT_ID')!;
const M_SEC   = Deno.env.get('MAUTIC_CLIENT_SECRET')!;
const M_USER  = Deno.env.get('MAUTIC_USERNAME')!;
const M_PASS  = Deno.env.get('MAUTIC_PASSWORD')!;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

type UserRow = {
  user_code: string;
  click_email: string | null;
  FullName: string | null;
  phone_number: string | null;
  organization: string | null;
  plan: string | null;
};

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: CORS });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const action = body?.action ?? 'push';

    if (action === 'ping') {
      return json({ ok: true, pong: true });
    }

    // 1) Supabase から users をページング取得
    const sb = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });

    const pageSize = Number(body.pageSize ?? 200);
    let page = Number(body.page ?? 0);
    let totalPushed = 0;
    let totalUpdated = 0;
    let totalSkipped = 0;

    // 2) Mautic アクセストークン
    const token = await getMauticToken();

    // 3) ページングで送る（email のあるユーザーのみ）
    while (true) {
      const from = page * pageSize;
      const to = from + pageSize - 1;

      const { data: users, error } = await sb
        .from('users')
        .select(
          'user_code, click_email, FullName, phone_number, organization, plan'
        )
        .not('click_email', 'is', null)
        .range(from, to);

      if (error) throw new Error(`[SB] select error: ${error.message}`);

      if (!users || users.length === 0) break;

      // 4) Mautic に upsert
      for (const u of users as UserRow[]) {
        if (!u.click_email) {
          totalSkipped++;
          continue;
        }
        try {
          const existed = await findContactByEmail(token, u.click_email);
          if (existed?.id) {
            await updateContact(token, existed.id, mapToMauticPayload(u));
            totalUpdated++;
          } else {
            await createContact(token, mapToMauticPayload(u));
            totalPushed++;
          }
        } catch (e) {
          // 個別ユーザーの失敗はスキップして続行
          console.error('[mautic] upsert error', u.user_code, e);
          totalSkipped++;
        }
      }

      if (users.length < pageSize) break; // 最終ページ
      page++;
      // 軽いレート制御
      await sleep(200);
    }

    return json({
      ok: true,
      result: { created: totalPushed, updated: totalUpdated, skipped: totalSkipped, pageStart: Number(body.page ?? 0) },
    });
  } catch (e: any) {
    console.error('[sync-mautic] error', e);
    return json({ ok: false, error: String(e?.message ?? e) }, 500);
  }
});

/* ---------------- helpers ---------------- */

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** OAuth2 password grant でトークン取得（簡易） */
async function getMauticToken(): Promise<string> {
  const url = `${MAUTIC}/oauth/v2/token`;
  const params = new URLSearchParams({
    grant_type: 'password',
    client_id: M_ID,
    client_secret: M_SEC,
    username: M_USER,
    password: M_PASS,
  });
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  });
  if (!res.ok) throw new Error(`[mautic] token failed: ${res.status} ${await res.text()}`);
  const j = await res.json();
  return j.access_token as string;
}

/** email で検索（存在すれば1件返す） */
async function findContactByEmail(token: string, email: string) {
  const url = `${MAUTIC}/api/contacts?search=${encodeURIComponent('email:' + email)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`[mautic] search failed: ${res.status} ${await res.text()}`);
  const j = await res.json();
  const list = j?.contacts ? Object.values(j.contacts as Record<string, any>) : [];
  return (list?.[0] as any) ?? null;
}

/** 連携用マッピング（必要に応じて拡張してください） */
function mapToMauticPayload(u: UserRow) {
  // Mautic v2 REST: contact[fields][core][email][value] 形式でも可
  // ここでは簡易フィールド（email, firstname, phone, company, plan）で例示
  return {
    email: u.click_email,
    firstname: u.FullName ?? undefined,
    phone: u.phone_number ?? undefined,
    company: u.organization ?? undefined,
    plan: u.plan ?? undefined, // カスタムフィールドがある前提（無ければ無視されます）
    user_code: u.user_code,
  };
}

async function createContact(token: string, payload: any) {
  const url = `${MAUTIC}/api/contacts/new`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ contact: payload }),
  });
  if (!res.ok) throw new Error(`[mautic] create failed: ${res.status} ${await res.text()}`);
}

async function updateContact(token: string, id: string | number, payload: any) {
  const url = `${MAUTIC}/api/contacts/${id}/edit`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ contact: payload }),
  });
  if (!res.ok) throw new Error(`[mautic] update failed: ${res.status} ${await res.text()}`);
}}
