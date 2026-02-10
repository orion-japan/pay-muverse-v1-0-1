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

    // ★ conversation_key を必ず取る（外部に出すID）
    const { data, error } = await sb
      .from('iros_conversations')
      .select('id,user_code,conversation_key,title,updated_at,created_at')
      .eq('user_code', userCode)
      .order('updated_at', { ascending: false })
      .limit(100);

    if (error) {
      console.error('[IROS/Conversations] Supabase error:', error);
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }

    console.log(`[IROS/Conversations] ✅ ${data?.length || 0} rows fetched for user_code=${userCode}`);

    const rows = (data ?? []) as any[];
    const conversations = rows
      .filter((r) => r && String(r.conversation_key ?? '').trim().length > 0)
      .map((r) => ({
        // ★ 重要：外部には conversation_key を返す（uuid id は出さない）
        id: String(r.conversation_key),
        title: r.title && String(r.title).trim() ? String(r.title) : '新規セッション',
        updated_at: r.updated_at || r.created_at || null,
      }));

    return NextResponse.json({ ok: true, conversations });
  } catch (err: any) {
    console.error('[IROS/Conversations] Fatal error:', err);
    return NextResponse.json({ ok: false, error: err?.message || 'internal error' }, { status: 500 });
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

      // ★ user_key NOT NULL 対策（依存増やさず user_code を使用）
      const userKey: string = String(body?.user_key ?? userCode);

      // ★ 外部キー（URLに出るやつ）: uuidは使わない
      // - クライアントが指定してきた場合はそれを使う（将来の互換）
      // - 無ければサーバで “uuid以外” を生成
      const requestedKeyRaw =
        (typeof body?.conversation_key === 'string' ? body.conversation_key : '') ||
        (typeof body?.conversationId === 'string' ? body.conversationId : '') ||
        '';
      const requestedKey = String(requestedKeyRaw).trim();

      const conversationKey =
        requestedKey ||
        `iros_${now.slice(0, 10).replace(/-/g, '')}_${Math.random().toString(36).slice(2, 8)}`;

      // ※ 存在しない列を避けるため、最低限の安全カラムのみを明示
      const insertRow: Record<string, any> = {
        user_code: userCode,
        user_key: userKey,
        conversation_key: conversationKey,
        title,
        updated_at: now,
      };

      // agent列が存在するなら入れる（存在しない環境でも落ちないように try-catch しないで素直に入れる）
      // ※ もし agent 列が無いなら、ここは消してください（あなたのDB定義に合わせる）
      insertRow.agent = 'iros';

      const { data, error } = await sb
        .from('iros_conversations')
        .insert([insertRow])
        .select('id,conversation_key')
        .single();

      if (error || !data) {
        console.error('[IROS/Conversations] create insert error:', error);
        return NextResponse.json({ ok: false, error: 'db_insert_failed' }, { status: 500 });
      }

      // ★ 重要：外部には conversation_key を返す（uuidを返さない）
      return NextResponse.json(
        {
          ok: true,
          conversationId: String((data as any).conversation_key),
          // 参考：内部uuid（必要ならデバッグ用。不要なら消してOK）
          uuid: String((data as any).id),
        },
        { status: 201 },
      );
    }

    // ---- rename ----
    if (action === 'rename') {
      // ★ 外部は conversation_key で扱う
      const cid = String(body?.conversationId ?? body?.id ?? '').trim(); // = conversation_key
      const title = String(body?.title ?? '').trim();
      if (!cid || !title) {
        return NextResponse.json({ ok: false, error: 'missing_parameters' }, { status: 400 });
      }

      // owner確認（conversation_key で引く）
      const { data: chk, error: chkErr } = await sb
        .from('iros_conversations')
        .select('id,user_code,conversation_key')
        .eq('conversation_key', cid)
        .single();

      if (chkErr || !chk) return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 });
      if (String((chk as any).user_code) !== String(userCode))
        return NextResponse.json({ ok: false, error: 'forbidden' }, { status: 403 });

      const { error: upErr } = await sb
        .from('iros_conversations')
        .update({ title, updated_at: new Date().toISOString() })
        .eq('conversation_key', cid);

      if (upErr) {
        console.error('[IROS/Conversations] rename update error:', upErr);
        return NextResponse.json({ ok: false, error: 'db_update_failed' }, { status: 500 });
      }

      return NextResponse.json({ ok: true });
    }

    // ---- delete ----
    if (action === 'delete') {
      const cid = String(body?.conversationId ?? body?.id ?? '').trim(); // = conversation_key
      if (!cid) return NextResponse.json({ ok: false, error: 'missing_parameters' }, { status: 400 });

      const { data: chk, error: chkErr } = await sb
        .from('iros_conversations')
        .select('id,user_code,conversation_key')
        .eq('conversation_key', cid)
        .single();

      if (chkErr || !chk) return NextResponse.json({ ok: false, error: 'not_found' }, { status: 404 });
      if (String((chk as any).user_code) !== String(userCode))
        return NextResponse.json({ ok: false, error: 'forbidden' }, { status: 403 });

      const { error: delErr } = await sb.from('iros_conversations').delete().eq('conversation_key', cid);
      if (delErr) {
        console.error('[IROS/Conversations] delete error:', delErr);
        return NextResponse.json({ ok: false, error: 'db_delete_failed' }, { status: 500 });
      }

      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ ok: false, error: 'unsupported_action' }, { status: 400 });
  } catch (err: any) {
    console.error('[IROS/Conversations] POST Fatal error:', err);
    return NextResponse.json({ ok: false, error: err?.message || 'internal error' }, { status: 500 });
  }
}
