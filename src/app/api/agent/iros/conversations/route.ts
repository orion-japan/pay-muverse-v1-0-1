// src/app/api/agent/iros/conversations/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { verifyFirebaseAndAuthorize, SUPABASE_URL, SERVICE_ROLE } from '@/lib/authz';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const sb = createClient(SUPABASE_URL!, SERVICE_ROLE!);

function makePublicKey(nowIso: string) {
  return `iros_${nowIso.slice(0, 10).replace(/-/g, '')}_${Math.random().toString(36).slice(2, 8)}`;
}

function resolveUserCode(req: NextRequest, auth: any): string {
  const headerUserCode = req.headers.get('x-user-code');
  const queryUserCode = new URL(req.url).searchParams.get('user_code');

  const userCode =
    headerUserCode ||
    queryUserCode ||
    (auth as any)?.user?.user_code ||
    (auth as any)?.userCode ||
    (auth as any)?.jwt?.sub ||
    '';

  return String(userCode || '').trim();
}

function supaErrorDetail(error: any) {
  return {
    message: error?.message ?? null,
    code: error?.code ?? null,
    hint: error?.hint ?? null,
    details: error?.details ?? null,
  };
}

// ========== GET: 会話一覧 ==========
export async function GET(req: NextRequest) {
  try {
    const auth = await verifyFirebaseAndAuthorize(req);
    if (!auth.ok) {
      return NextResponse.json({ ok: false, error: auth.error || 'unauthorized' }, { status: 401 });
    }

    const userCode = resolveUserCode(req, auth);
    if (!userCode) {
      return NextResponse.json({ ok: false, error: 'no user_code' }, { status: 400 });
    }

    // ✅ id(UUID) を UI の主キーとして返す。conversation_key は public_id として付加する。
    const { data, error } = await sb
      .from('iros_conversations')
      .select('id,user_code,conversation_key,title,updated_at,created_at')
      .eq('user_code', userCode)
      .order('updated_at', { ascending: false })
      .limit(100);

    if (error) {
      console.error('[IROS][conversations][get_failed]', {
        userCode,
        error,
      });

      return NextResponse.json(
        { ok: false, error: 'db_select_failed', detail: supaErrorDetail(error) },
        { status: 500 },
      );
    }

    const rows = (data ?? []) as any[];
    const conversations = rows.map((r) => ({
      // ✅ UIが使うのは常に内部UUID
      id: String(r.id),
      // 共有/表示などで必要なら使う（無くてもOK）
      public_id: r.conversation_key ? String(r.conversation_key) : null,
      title: r.title && String(r.title).trim() ? String(r.title) : '新規セッション',
      updated_at: r.updated_at || r.created_at || null,
    }));

    return NextResponse.json({ ok: true, conversations });
  } catch (err: any) {
    console.error('[IROS][conversations][get_exception]', { err });
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

    const userCode = resolveUserCode(req, auth);
    if (!userCode) {
      return NextResponse.json({ ok: false, error: 'no user_code' }, { status: 400 });
    }

    let body: any = {};
    try {
      body = await req.json();
    } catch {}

    const action: string = String(body?.action ?? 'create');

    // ---- create ----
    if (action === 'create') {
      const title = String(body?.title ?? '新しい会話').trim() || '新しい会話';
      const now = new Date().toISOString();

      // 互換：クライアントから指定があれば使う
      const requestedKeyRaw =
        (typeof body?.conversation_key === 'string' ? body.conversation_key : '') ||
        (typeof body?.public_id === 'string' ? body.public_id : '') ||
        (typeof body?.conversationId === 'string' ? body.conversationId : '') ||
        '';
      const requestedKey = String(requestedKeyRaw).trim();

      const conversationKey = requestedKey || makePublicKey(now);

      const insertRow: Record<string, any> = {
        user_code: userCode,
        // ✅ DBスキーマ都合：user_key が NOT NULL のため必ず埋める（暫定は userCode と同値）
        user_key: userCode,

        conversation_key: conversationKey,
        title,
        updated_at: now,
      };


      const { data, error } = await sb
        .from('iros_conversations')
        .insert([insertRow])
        .select('id,conversation_key')
        .single();

      if (error || !data) {
        console.error('[IROS][conversations][insert_failed]', {
          userCode,
          insertRow,
          error,
        });

        return NextResponse.json(
          { ok: false, error: 'db_insert_failed', detail: supaErrorDetail(error) },
          { status: 500 },
        );
      }

      // ✅ 重要：UIが使うのは uuid(id)
      return NextResponse.json(
        {
          ok: true,
          conversationId: String((data as any).id), // UUID
          public_id: String((data as any).conversation_key ?? ''),
        },
        { status: 201 },
      );
    }

    // ---- rename ----
    if (action === 'rename') {
      const cid = String(body?.conversationId ?? body?.id ?? '').trim(); // ✅ uuid
      const title = String(body?.title ?? '').trim();
      if (!cid || !title) return NextResponse.json({ ok: false, error: 'missing_parameters' }, { status: 400 });

      const { data: chk, error: chkErr } = await sb
        .from('iros_conversations')
        .select('id,user_code')
        .eq('id', cid)
        .single();

      if (chkErr || !chk) {
        console.error('[IROS][conversations][rename_check_failed]', {
          userCode,
          cid,
          chkErr,
        });
        return NextResponse.json(
          { ok: false, error: 'not_found', detail: supaErrorDetail(chkErr) },
          { status: 404 },
        );
      }
      if (String((chk as any).user_code) !== String(userCode)) {
        return NextResponse.json({ ok: false, error: 'forbidden' }, { status: 403 });
      }

      const { error: upErr } = await sb
        .from('iros_conversations')
        .update({ title, updated_at: new Date().toISOString() })
        .eq('id', cid);

      if (upErr) {
        console.error('[IROS][conversations][rename_update_failed]', {
          userCode,
          cid,
          upErr,
        });
        return NextResponse.json(
          { ok: false, error: 'db_update_failed', detail: supaErrorDetail(upErr) },
          { status: 500 },
        );
      }

      return NextResponse.json({ ok: true });
    }

    // ---- delete ----
    if (action === 'delete') {
      const cid = String(body?.conversationId ?? body?.id ?? '').trim(); // ✅ uuid
      if (!cid) return NextResponse.json({ ok: false, error: 'missing_parameters' }, { status: 400 });

      const { data: chk, error: chkErr } = await sb
        .from('iros_conversations')
        .select('id,user_code')
        .eq('id', cid)
        .single();

      if (chkErr || !chk) {
        console.error('[IROS][conversations][delete_check_failed]', {
          userCode,
          cid,
          chkErr,
        });
        return NextResponse.json(
          { ok: false, error: 'not_found', detail: supaErrorDetail(chkErr) },
          { status: 404 },
        );
      }
      if (String((chk as any).user_code) !== String(userCode)) {
        return NextResponse.json({ ok: false, error: 'forbidden' }, { status: 403 });
      }

      const { error: delErr } = await sb.from('iros_conversations').delete().eq('id', cid);

      if (delErr) {
        console.error('[IROS][conversations][delete_failed]', {
          userCode,
          cid,
          delErr,
        });
        return NextResponse.json(
          { ok: false, error: 'db_delete_failed', detail: supaErrorDetail(delErr) },
          { status: 500 },
        );
      }

      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ ok: false, error: 'unsupported_action' }, { status: 400 });
  } catch (err: any) {
    console.error('[IROS][conversations][post_exception]', { err });
    return NextResponse.json({ ok: false, error: err?.message || 'internal error' }, { status: 500 });
  }
}
