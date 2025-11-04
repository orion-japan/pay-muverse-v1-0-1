// supabase/functions/sync-mautic/index.ts
// @ts-nocheck
// deno-lint-ignore-file

import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ====== ENV ======
const SB_URL = Deno.env.get('SUPABASE_URL')!; // プロジェクトURL
const SB_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!; // SRK（必須）
const MAUTIC = (Deno.env.get('MAUTIC_BASE') ?? '').replace(/\/+$/, '');
const M_ID = Deno.env.get('MAUTIC_CLIENT_ID') ?? '';
const M_SEC = Deno.env.get('MAUTIC_CLIENT_SECRET') ?? '';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// ====== 型（実テーブルに列が無くても optional にして落ちないように）======
type UserRow = {
  user_code?: string | null;
  click_email?: string | null;
  FullName?: string | null;
  phone_number?: string | null;
  phone_e164?: string | null;
  organization?: string | null;
  plan?: string | null;
  plan_status?: string | null;
  click_username?: string | null;
  supabase_uid?: string | null;
};

// ====== HTTP Entrypoint ======
serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  try {
    const body = await req.json().catch(() => ({}));
    const action = body?.action ?? 'push';
    const pageSize = clampInt(body?.pageSize, 1, 1000, 200);
    const page = clampInt(body?.page, 0, 1_000_000, 0);
    const dryRun = !!body?.dryRun;
    const previewCount = clampInt(body?.limit, 1, 50, 3);

    // 簡易ヘルスチェック
    if (action === 'ping') return json({ ok: true, pong: true });

    // 設定チェック（不足時は即時メッセージ）
    if (!SB_URL || !SB_KEY) {
      return json({ ok: false, error: 'SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set' }, 500);
    }

    // Mautic トークンは必要な時だけ（dryRun ではスキップ）
    let token = '';
    if (action === 'token') {
      token = await getMauticToken();
      return json({ ok: true, tokenPreview: token?.slice(0, 12) + '...' });
    }

    // 接続
    const sb = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });

    // API: users ペイロード「だけ」事前確認できるよう preview を用意
    if (action === 'preview') {
      const users = await fetchUsersPage(sb, 0, previewCount);
      const mapped = users.filter((u) => isNonEmptyEmail(u?.click_email)).map(mapToMauticPayload);
      return json({ ok: true, sample: mapped });
    }

    // push 本体
    if (action === 'push') {
      // dryRun でなければ Mautic トークン確保
      if (!dryRun) token = await getMauticToken();

      let cur = page;
      let totalCreated = 0;
      let totalUpdated = 0;
      let totalSkipped = 0;

      while (true) {
        const from = cur * pageSize;
        const users = await fetchUsersPage(sb, from, pageSize);
        if (!users.length) break;

        for (const u of users) {
          const email = (u?.click_email ?? '').trim();
          if (!isNonEmptyEmail(email)) {
            totalSkipped++;
            continue;
          }

          try {
            const payload = mapToMauticPayload(u);

            if (dryRun) {
              // 書き込みはしないが検索だけ行うと 4xx が原因切り分けに便利
              // 完全にネットワークを切りたい時は findContactByEmail をコメントアウト
              // const existed = null;
              const existed = await safeFind(token, email, dryRun);
              if (existed?.id) totalUpdated++;
              else totalCreated++;
              continue;
            }

            const existed = await findContactByEmail(token, email);
            if (existed?.id) {
              await updateContact(token, existed.id, payload);
              totalUpdated++;
            } else {
              await createContact(token, payload);
              totalCreated++;
            }
          } catch (e) {
            console.error('[mautic] upsert error', u?.user_code ?? email, e);
            totalSkipped++;
          }
        }

        if (users.length < pageSize) break;
        cur++;
        await sleep(150);
      }

      return json({
        ok: true,
        result: {
          created: totalCreated,
          updated: totalUpdated,
          skipped: totalSkipped,
          dryRun,
          pageStart: page,
          pageSize,
        },
      });
    }

    return json({ ok: false, error: `unknown action: ${action}` }, 400);
  } catch (e: any) {
    console.error('[sync-mautic] fatal', e);
    return json({ ok: false, error: String(e?.message ?? e) }, 500);
  }
});

// ====== helpers ======
function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clampInt = (v: any, min: number, max: number, def: number) => {
  const n = Number.isFinite(+v) ? Math.trunc(+v) : def;
  return Math.min(Math.max(n, min), max);
};
const isNonEmptyEmail = (s?: string | null) =>
  !!s && typeof s === 'string' && /\S+@\S+\.\S+/.test(s.trim());

// —— Supabase から users をページング取得（存在しない列は SELECT しない）——
async function fetchUsersPage(sb: any, from: number, limit: number): Promise<UserRow[]> {
  const to = from + limit - 1;

  // ★ここに “実在する列だけ” を並べる（あなたのテーブルに合わせてあります）
  const columns =
    'user_code, click_email, FullName, phone_number, phone_e164, organization, plan, plan_status, click_username, supabase_uid';

  const { data, error } = await sb
    .from('users')
    .select(columns)
    .not('click_email', 'is', null)
    .range(from, to);

  if (error) throw new Error(`[SB] select error: ${error.message}`);
  return (data ?? []) as UserRow[];
}

// —— Mautic: client_credentials でトークン ——
// 失敗時はエラー文を含めて throw
async function getMauticToken(): Promise<string> {
  if (!MAUTIC || !M_ID || !M_SEC) {
    throw new Error('[mautic] env not set: MAUTIC_BASE / MAUTIC_CLIENT_ID / MAUTIC_CLIENT_SECRET');
  }
  const url = `${MAUTIC}/oauth/v2/token`;
  const params = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: M_ID,
    client_secret: M_SEC,
  });
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: params,
  });
  if (!res.ok) throw new Error(`[mautic] token failed: ${res.status} ${await res.text()}`);
  const j = await res.json();
  if (!j?.access_token) throw new Error('[mautic] token missing access_token');
  return j.access_token as string;
}

async function safeFind(token: string, email: string, dryRun: boolean) {
  try {
    return await findContactByEmail(token, email);
  } catch (e) {
    // dryRun でも失敗理由が分かるように返す
    console.error('[mautic] search (dryRun) failed:', e);
    return null;
  }
}

async function findContactByEmail(token: string, email: string) {
  const url = `${MAUTIC}/api/contacts?search=${encodeURIComponent('email:' + email)}&limit=1`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`[mautic] search failed: ${res.status} ${await res.text()}`);
  const j = await res.json();
  const list = j?.contacts ? Object.values(j.contacts as Record<string, any>) : [];
  return (list?.[0] as any) ?? null;
}

function mapToMauticPayload(u: UserRow) {
  // 送信フィールドは “存在すれば” 詰める（undefined は JSON 化時に落ちない）
  // phone は E.164 を優先
  const phone = (u?.phone_e164 ?? u?.phone_number ?? undefined) || undefined;

  return {
    email: u?.click_email ?? undefined,
    firstname: u?.FullName ?? undefined,
    phone: phone,
    company: u?.organization ?? undefined,
    plan: u?.plan ?? undefined, // カスタムフィールド想定（未定義なら無視される）
    plan_status: u?.plan_status ?? undefined, // 同上
    username: u?.click_username ?? undefined, // 同上（必要なければ削除OK）
    user_code: u?.user_code ?? undefined, // 同上
    supabase_uid: u?.supabase_uid ?? undefined,
  };
}

async function createContact(token: string, payload: any) {
  const url = `${MAUTIC}/api/contacts/new`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
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
      Accept: 'application/json',
    },
    body: JSON.stringify({ contact: payload }),
  });
  if (!res.ok) throw new Error(`[mautic] update failed: ${res.status} ${await res.text()}`);
}
