// src/app/api/visions/archive/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

/**
 * POST /api/visions/archive
 * body: { vision_id: string }  // 互換: { visionId } / { id } でもOK
 * 履歴へ移管（archived_at / moved_to_history_at = now）
 */
export async function POST(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const userCodeHeader =
      req.headers.get('x-user-code') ||
      url.searchParams.get('user_code') ||
      '';

    const body = (await req.json().catch(() => ({}))) as any;
    const rawId: string | undefined =
      body?.vision_id || body?.visionId || body?.id;
    const vision_id = (rawId ?? '').trim();

    if (!vision_id) {
      return NextResponse.json({ error: 'missing vision_id' }, { status: 400 });
    }

    // ① まず vision を取得して実在確認＆所有者を把握
    const found = await supabase
      .from('visions')
      .select('vision_id,user_code,archived_at,moved_to_history_at')
      .eq('vision_id', vision_id)
      .maybeSingle();

    if (found.error) {
      console.error('[archive] select error', found.error);
      return NextResponse.json({ error: found.error.message }, { status: 500 });
    }
    if (!found.data) {
      console.warn('[archive] not found', { vision_id, userCodeHeader });
      return NextResponse.json({ error: 'not found' }, { status: 404 });
    }

    const owner = String(found.data.user_code ?? '');

    // ② ヘッダと所有者が食い違っても、開発中は続行（ログだけ残す）
    if (userCodeHeader && userCodeHeader !== owner) {
      console.warn('[archive] user_code mismatch', {
        header: userCodeHeader,
        owner,
        vision_id,
      });
    }

    // ③ 更新は vision_id で一意更新（RLSが有ればサーバーキーで通る想定）
    const nowIso = new Date().toISOString();
    const patch = {
      archived_at: nowIso,
      moved_to_history_at: nowIso,
      updated_at: nowIso,
    };

    console.log('[archive] ▶ update start', { vision_id, patch });

    const upd = await supabase
      .from('visions')
      .update(patch)
      .eq('vision_id', vision_id)
      .select('vision_id,user_code,archived_at,moved_to_history_at,updated_at')
      .maybeSingle();

    if (upd.error) {
      console.error('[archive] update error', upd.error);
      return NextResponse.json({ error: upd.error.message }, { status: 500 });
    }
    if (!upd.data) {
      console.warn('[archive] ⚠ no row updated after select-ok', { vision_id });
      return NextResponse.json({ error: 'not found' }, { status: 404 });
    }

    if (!upd.data.moved_to_history_at) {
      return NextResponse.json(
        { error: 'update did not apply', data: upd.data },
        { status: 500 }
      );
    }

    console.log('[archive] ✅ done', upd.data);
    return NextResponse.json({ ok: true, data: upd.data });
  } catch (e: any) {
    console.error('[archive] ❌ unexpected', e);
    return NextResponse.json(
      { error: e?.message || 'server error' },
      { status: 500 }
    );
  }
}
