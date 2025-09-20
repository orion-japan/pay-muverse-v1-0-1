import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_ROLE =
  process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_SERVICE_ROLE_KEY!;

type ConvRow = {
  user_code: string;
  last_turn_at: string | null;
  created_at: string | null;
};

type UsersByCode = { user_code?: string; click_username?: string | null };
type CodeToIdRow = { code: string; user_id: string };
type UsersById = { id?: string; click_username?: string | null };

function chunk<T>(arr: T[], size = 1000): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export async function GET(req: NextRequest) {
  try {
    const sb = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });
    const url = new URL(req.url);

    const q = (url.searchParams.get('q') || '').trim();
    const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') || 200)));

    // 1) 会話のある user_code を新しい順で取得
    const { data, error } = await sb
      .from('mu_conversations')
      .select('user_code,last_turn_at,created_at')
      .order('last_turn_at', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })
      .limit(5000);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    // 2) JS側でユーザー集計
    const agg = new Map<string, { user_code: string; last_turn_at: string | null; conversations: number }>();
    for (const r of (data || []) as ConvRow[]) {
      if (!r.user_code) continue;
      const last = r.last_turn_at || r.created_at || null;
      const cur = agg.get(r.user_code);
      if (!cur) agg.set(r.user_code, { user_code: r.user_code, last_turn_at: last, conversations: 1 });
      else {
        cur.conversations += 1;
        if (last && (!cur.last_turn_at || last > cur.last_turn_at)) cur.last_turn_at = last;
      }
    }
    let users = Array.from(agg.values());
    const codes = users.map(u => u.user_code);

    // 3) 表示名の解決：users.click_username を最優先
    const nameMap: Record<string, string> = {};

    // 3-1) users.user_code が存在する構成
    for (const part of chunk(codes, 1000)) {
      try {
        const { data: uByCode } =
          await sb.from('users').select('user_code,click_username').in('user_code', part) as unknown as { data: UsersByCode[] | null };
        for (const u of uByCode ?? []) {
          if (u.user_code && (u.click_username ?? '') !== '') {
            nameMap[u.user_code] = u.click_username as string;
          }
        }
      } catch { /* noop */ }
    }

    // 3-2) user_q_codes(code → user_id) 経由で users.id → click_username を引く構成
    const missing = codes.filter(c => !nameMap[c]);
    if (missing.length) {
      let codeToId: Record<string, string> = {};
      for (const part of chunk(missing, 1000)) {
        try {
          const { data: mapRows } =
            await sb.from('user_q_codes').select('code,user_id').in('code', part) as unknown as { data: CodeToIdRow[] | null };
          for (const r of mapRows ?? []) {
            if (r.code && r.user_id) codeToId[r.code] = r.user_id;
          }
        } catch { /* noop */ }
      }
      const ids = Object.values(codeToId);
      for (const part of chunk(ids, 1000)) {
        try {
          const { data: uById } =
            await sb.from('users').select('id,click_username').in('id', part) as unknown as { data: UsersById[] | null };
          for (const u of uById ?? []) {
            const code = Object.keys(codeToId).find(c => codeToId[c] === u.id);
            if (code && (u.click_username ?? '') !== '' && !nameMap[code]) {
              nameMap[code] = u.click_username as string;
            }
          }
        } catch { /* noop */ }
      }
    }

    // 4) 整形・検索・並び・件数
    let items = users.map(u => ({
      user_code: u.user_code,
      name: nameMap[u.user_code] || u.user_code, // ← 取得できなければコードを表示
      conversations: u.conversations,
      last_turn_at: u.last_turn_at,
    }));

    if (q) {
      const k = q.toLowerCase();
      items = items.filter(x =>
        x.user_code.toLowerCase().includes(k) ||
        (x.name || '').toLowerCase().includes(k)
      );
    }

    items.sort((a, b) => (b.last_turn_at || '').localeCompare(a.last_turn_at || ''));
    items = items.slice(0, limit);

    return NextResponse.json({ users: items });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'failed' }, { status: 500 });
  }
}
