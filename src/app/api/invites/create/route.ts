// /src/app/api/invites/create/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

function generateInviteCode(prefix = 'MU'): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let body = '';
  for (let i = 0; i < 6; i++) body += alphabet[Math.floor(Math.random() * alphabet.length)];
  return `${prefix}-${body}`;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { creator_user_code, max_uses = 1, expires_at = null, notes = null } = body ?? {};
    if (!creator_user_code) {
      return NextResponse.json({ ok: false, error: 'missing: creator_user_code' }, { status: 400 });
    }

    // 作成者がリーダー？
    const { data: creatorRow, error: uErr } = await supabaseAdmin
      .from('users')
      .select('is_leader')
      .eq('user_code', creator_user_code)
      .maybeSingle();
    if (uErr) throw new Error(`users select failed: ${uErr.message}`);

    let group_id: string | null = null;
    if (creatorRow?.is_leader) {
      // 自グループを取得 or 作成
      const { data: g } = await supabaseAdmin
        .from('groups')
        .select('id, group_code')
        .eq('leader_user_code', creator_user_code)
        .maybeSingle();

      if (g?.id) {
        group_id = g.id;
      } else {
        // group_code は leader の user_code を流用（例: 336699）
        const { data: newg, error: gErr } = await supabaseAdmin
          .from('groups')
          .insert({
            group_code: creator_user_code,
            leader_user_code: creator_user_code,
            name: `Group ${creator_user_code}`,
            description: 'auto created on invite',
          })
          .select('id')
          .single();
        if (gErr) throw new Error(`groups insert failed: ${gErr.message}`);
        group_id = newg.id;

        // leader をメンバー化
        await supabaseAdmin.from('group_members').upsert({
          group_id,
          user_code: creator_user_code,
          role: 'leader',
        });
      }
    }

    // 重複回避しつつコード生成（最大5回試行）
    let code = '';
    for (let i = 0; i < 5; i++) {
      const cand = generateInviteCode('MU');
      const { data: exists, error: e1 } = await supabaseAdmin
        .from('invite_codes')
        .select('id')
        .eq('code', cand)
        .maybeSingle();
      if (e1) throw e1;
      if (!exists) {
        code = cand;
        break;
      }
    }
    if (!code)
      return NextResponse.json({ ok: false, error: 'code generation failed' }, { status: 500 });

    const { data: inserted, error } = await supabaseAdmin
      .from('invite_codes')
      .insert({
        code,
        creator_user_code,
        group_id, // リーダーなら自グループ、一般なら null
        max_uses,
        expires_at,
        notes,
      })
      .select('*')
      .single();

    if (error) throw new Error(error.message);

    return NextResponse.json({ ok: true, invite: inserted });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message ?? 'unknown error' }, { status: 500 });
  }
}
