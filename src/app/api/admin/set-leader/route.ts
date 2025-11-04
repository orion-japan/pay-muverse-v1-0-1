import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

/** 必須パラメータ確認 */
function required<T extends object>(
  obj: T,
  keys: (keyof T)[],
): { ok: true } | { ok: false; missing: string[] } {
  const missing = keys.filter((k) => !obj[k]);
  return missing.length ? { ok: false, missing: missing as string[] } : { ok: true };
}

/** groups / group_members が無い場合に最低限作成する */
async function ensureTables() {
  {
    const sql = `
      create table if not exists groups (
        id uuid primary key default gen_random_uuid(),
        group_code text unique not null,
        leader_user_code text not null references users(user_code),
        name text not null,
        description text,
        created_at timestamptz not null default now()
      );
    `;
    const { error } = await supabaseAdmin.rpc('exec_sql', { sql });
    if (error && !/already exists|duplicate|42P07/i.test(error.message)) {
      throw new Error(`DDL(groups) failed: ${error.message}`);
    }
  }

  {
    const sql = `
      create table if not exists group_members (
        group_id uuid not null references groups(id) on delete cascade,
        user_code text not null references users(user_code) on delete cascade,
        role text not null default 'member',
        joined_at timestamptz not null default now(),
        primary key (group_id, user_code)
      );
    `;
    const { error } = await supabaseAdmin.rpc('exec_sql', { sql });
    if (error && !/already exists|duplicate|42P07/i.test(error.message)) {
      throw new Error(`DDL(group_members) failed: ${error.message}`);
    }
  }
}

/**
 * 注意：
 * exec_sql RPC を事前にDBへ作ってください（service_role専用）
 *
 * create or replace function exec_sql(sql text)
 * returns void language plpgsql security definer as $$
 * begin
 *   execute sql;
 * end; $$;
 *
 * revoke all on function exec_sql(text) from public;
 * grant execute on function exec_sql(text) to service_role;
 */

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      leader_user_code, // リーダーにする user_code
      origin_user_code, // 派生元 user_code
      group_code, // グループコード
      created_by = 'admin-ui',
    } = body ?? {};

    const chk = required(body, ['leader_user_code', 'group_code']);
    if (chk.ok === false) {
      return NextResponse.json(
        { success: false, error: `missing: ${chk.missing.join(', ')}` },
        { status: 400 },
      );
    }

    // groups / group_members が無い環境でも動く
    await ensureTables();

    /** 1) users: is_leader / leader_origin を更新 */
    {
      const { error } = await supabaseAdmin
        .from('users')
        .update({ is_leader: true, leader_origin: origin_user_code ?? null })
        .eq('user_code', leader_user_code);
      if (error) throw new Error(`users update failed: ${error.message}`);
    }

    /** 2) groups: upsert */
    let group_id: string;
    {
      const { data: g, error } = await supabaseAdmin
        .from('groups')
        .select('id')
        .eq('group_code', group_code)
        .maybeSingle();
      if (error) throw new Error(`groups select failed: ${error.message}`);

      if (g?.id) {
        group_id = g.id;
      } else {
        const { data: inserted, error: e2 } = await supabaseAdmin
          .from('groups')
          .insert({
            group_code,
            leader_user_code,
            name: `Group ${group_code}`,
            description: `Created by ${created_by}`,
          })
          .select('id')
          .single();
        if (e2) throw new Error(`groups insert failed: ${e2.message}`);
        group_id = inserted.id;
      }
    }

    /** 3) group_members: leader を upsert */
    {
      const { error } = await supabaseAdmin
        .from('group_members')
        .upsert({ group_id, user_code: leader_user_code, role: 'leader' });
      if (error) throw new Error(`group_members upsert failed: ${error.message}`);
    }

    return NextResponse.json({
      success: true,
      leader_user_code,
      group_code,
      tier_level: 1, // 暫定
    });
  } catch (e: any) {
    return NextResponse.json(
      { success: false, error: e?.message ?? 'unknown error' },
      { status: 500 },
    );
  }
}
