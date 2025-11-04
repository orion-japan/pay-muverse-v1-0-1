// src/app/api/sofia-logs/users/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_SERVICE_ROLE_KEY!;

function sb() {
  return createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });
}

export async function GET(_req: NextRequest) {
  try {
    // sofia_conversations を基準に集計し、users テーブルから名前を引く
    const supabase = sb();

    const { data: rows, error } = await supabase
      .from('sofia_conversations')
      .select('user_code, last_turn_at')
      .order('last_turn_at', { ascending: false });

    if (error) throw error;

    // 集計（会話数・最終更新）
    const map = new Map<string, { conversations: number; last_turn_at: string | null }>();
    for (const r of rows ?? []) {
      const k = r.user_code;
      if (!k) continue;
      const cur = map.get(k) || { conversations: 0, last_turn_at: null };
      cur.conversations += 1;
      cur.last_turn_at =
        cur.last_turn_at && r.last_turn_at && cur.last_turn_at > r.last_turn_at
          ? cur.last_turn_at
          : r.last_turn_at || cur.last_turn_at;
      map.set(k, cur);
    }

    const userCodes = Array.from(map.keys());
    const names: Record<string, string> = {};
    if (userCodes.length) {
      const { data: profiles } = await supabase
        .from('users') // ← 貴環境の「名前持ち」テーブル。users.click_username 等に合わせてください
        .select('user_code, click_username')
        .in('user_code', userCodes);
      for (const p of profiles ?? []) {
        names[p.user_code] = p.click_username || '';
      }
    }

    const users = userCodes.map((uc) => ({
      user_code: uc,
      name: names[uc] || uc,
      conversations: map.get(uc)!.conversations,
      last_turn_at: map.get(uc)!.last_turn_at,
    }));

    return NextResponse.json({ users });
  } catch (e: any) {
    return NextResponse.json({ users: [], error: e?.message || String(e) }, { status: 400 });
  }
}
