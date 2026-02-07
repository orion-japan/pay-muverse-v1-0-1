// src/app/api/agent/iros/conversations/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { verifyFirebaseAndAuthorize, SUPABASE_URL, SERVICE_ROLE } from '@/lib/authz';

const sb = createClient(SUPABASE_URL!, SERVICE_ROLE!);

interface IrosConversationRow {
  id: string;
  user_code: string;
  title: string | null;
  created_at: string | null;
  updated_at: string | null;
}

// ========== GET: 会話一覧 ==========
export async function GET(req: NextRequest) {
  try {
    const auth = await verifyFirebaseAndAuthorize(req);
    console.log('[IROS/Conversations] auth =', auth);

    if (!auth.ok) {
      console.warn('[IROS/Conversations] unauthorized');
      return NextResponse.json({ ok: false, error: auth.error || 'unauthorized' }, { status: 401 });
    }

    // user_code は auth から直接採用（users.user_key などには一切依存しない）
    const headerUserCode = req.headers.get('x-user-code');
    const queryUserCode = new URL(req.url).searchParams.get('user_code');

    // ✅ iros の owner は「数値 user_code」のみを許可（uid を user_code として使うのは禁止）
    const userCode =
      headerUserCode ||
      queryUserCode ||
      (auth as any)?.user?.user_code ||
      (auth as any)?.userCode ||
      (auth as any)?.jwt?.sub ||
      '';

    console.log('[IROS/Conversations] Query target user_code =', userCode);
    if (!userCode) {
      console.error('[IROS/Conversations] ❌ user_code missing');
      return NextResponse.json({ ok: false, error: 'no user_code' }, { status: 400 });
    }

    const { data, error } = await sb
      .from('iros_conversations')
      .select('id,user_code,title,updated_at,created_at')
      .eq('user_code', userCode)
      .order('updated_at', { ascending: false })
      .limit(100);

    if (error) {
      console.error('[IROS/Conversations] Supabase error:', error);
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }

    console.log(`[IROS/Conversations] ✅ ${data?.length || 0} rows fetched for user_code=${userCode}`);

    const rows = (data ?? []) as IrosConversationRow[];
    const conversations = rows.map((r) => ({
      id: r.id,
      title: r.title && r.title.trim() ? r.title : '新規セッション',
      updated_at: r.updated_at || r.created_at || null,
    }));

    return NextResponse.json({ ok: true, conversations });
  } catch (err: any) {
    console.error('[IROS/Conversations] Fatal error:', err);
    return NextResponse.json(
      { ok: false, error: err?.message || 'internal error' },
      { status: 500 },
    );
  }
}

// ========== POST: create / rename / delete ==========
export async function POST(req: NextRequest) {
  try {
    const auth = await verifyFirebaseAndAuthorize(req);
    if (!auth.ok) {
      return NextResponse.json({ ok: false, error: auth.error || 'unauthorized' }, { status: 401 });
    }

    const headerUserCode = req.headers.get('x-user-code');
    const queryUserCode = new URL(req.url).searchParams.get('user_code');

    // ✅ iros の owner は「数値 user_code」のみを許可（uid を user_code として使うのは禁止）
    const userCode =
      headerUserCode ||
      queryUserCode ||
      (auth as any)?.user?.user_code ||
      (auth as any)?.userCode ||
      (auth as any)?.jwt?.sub ||
      '';


    if (!userCode) {
      return NextResponse.json({ ok: false, error: 'no user_code' }, { status: 400 });
    }

    let body: any = {};
    try {
      body = await req.json();
    } catch {
      /* no-op */
    }

    const action: string = String(body?.action ?? 'create');

    // ---- create ----
    if (action === 'create') {
      const title = String(body?.title ?? '新しい会話').trim() || '新しい会話';
      const now = new Date().toISOString();

      // ★ 追加：user_key NOT NULL 対策。依存を増やさず user_code をフォールバック使用
      const userKey: string = String(body?.user_key ?? userCode);

      // ※ 存在しない列を避けるため、最低限の安全カラムのみを明示
      const insertRow: Record<string, any> = {
        user_code: userCode,
        user_key: userKey, // ← 重要：NOT NULL
        title,
        updated_at: now,
      };

      const { data, error } = await sb
        .from('iros_conversations')
        .insert([insertRow])
        .select('id')
        .single();

      if (error || !data) {
        console.error('[IROS/Conversations] create insert error:', error);
        return NextResponse.json({ ok: false, error: 'db_insert_failed' }, { status: 500 });
      }

      return NextResponse.json({ ok: true, conversationId: String(data.id) }, { status: 201 });
    }

    // ---- rename ----
    if (action === 'rename') {
      const id = String(body?.id ?? body?.conversationId ?? '');
      const title = String(body?.title ?? '').trim();
      if (!id || !title) {
        return NextResponse.json({ ok: false, error: 'missing_parameters' }, { status: 400 });
      }

      const { data: chk, error: chkErr } = await sb
        .from('iros_conversations')
        .select('id,user_code')
        .eq('id', id)
        .single();
      if (chkErr || !chk)
        return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 });
      if (String(chk.user_code) !== String(userCode))
        return NextResponse.json({ ok: false, error: 'forbidden' }, { status: 403 });

      const { error: upErr } = await sb
        .from('iros_conversations')
        .update({ title, updated_at: new Date().toISOString() })
        .eq('id', id);

      if (upErr) {
        console.error('[IROS/Conversations] rename update error:', upErr);
        return NextResponse.json({ ok: false, error: 'db_update_failed' }, { status: 500 });
      }
      return NextResponse.json({ ok: true });
    }

    // ---- delete ----
    if (action === 'delete') {
      const id = String(body?.id ?? body?.conversationId ?? '');
      if (!id)
        return NextResponse.json({ ok: false, error: 'missing_parameters' }, { status: 400 });

      const { data: chk, error: chkErr } = await sb
        .from('iros_conversations')
        .select('id,user_code')
        .eq('id', id)
        .single();
      if (chkErr || !chk)
        return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 });
      if (String(chk.user_code) !== String(userCode))
        return NextResponse.json({ ok: false, error: 'forbidden' }, { status: 403 });

      const { error: delErr } = await sb.from('iros_conversations').delete().eq('id', id);
      if (delErr) {
        console.error('[IROS/Conversations] delete error:', delErr);
        return NextResponse.json({ ok: false, error: 'db_delete_failed' }, { status: 500 });
      }
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ ok: false, error: 'unsupported_action' }, { status: 400 });
  } catch (err: any) {
    console.error('[IROS/Conversations] POST Fatal error:', err);
    return NextResponse.json(
      { ok: false, error: err?.message || 'internal error' },
      { status: 500 },
    );
  }
}
