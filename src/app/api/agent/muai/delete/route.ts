export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { verifyFirebaseAndAuthorize, SUPABASE_URL, SERVICE_ROLE } from '@/lib/authz';

const json = (data: any, init?: number | ResponseInit) =>
  new NextResponse(JSON.stringify(data), {
    status:
      typeof init === 'number' ? init : ((init as ResponseInit | undefined)?.['status'] ?? 200),
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

type AnyBody = { conversation_id?: string; conv_id?: string; id?: string } | string | undefined;

function pickConvId(body: AnyBody, url: URL): string | undefined {
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body) as AnyBody;
    } catch {}
  }
  const b = (body as any) ?? {};
  return (
    b.conversation_id ||
    b.conv_id ||
    b.id ||
    url.searchParams.get('conversation_id') ||
    url.searchParams.get('conv_id') ||
    url.searchParams.get('id') ||
    undefined
  );
}

async function handler(req: NextRequest) {
  try {
    const auth = await verifyFirebaseAndAuthorize(req);
    if (!auth?.ok) return json({ ok: false, error: 'unauthorized' }, 401);
    const user_code = (auth as any).userCode ?? (auth as any).user_code;
    if (!user_code) return json({ ok: false, error: 'no_user_code' }, 401);

    const url = new URL(req.url);
    const raw = await req.text().catch(() => '');
    const convId = pickConvId(raw, url);

    console.info('[mu/delete] received', { convId, query: url.search, raw });

    if (!convId || !String(convId).trim()) return json({ ok: false, error: 'bad_request' }, 400);

    const db = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

    // mu_turns -> conv_id(text) / user_code(text)
    const t = await db.from('mu_turns').delete().eq('user_code', user_code).eq('conv_id', convId);
    if (t.error) {
      console.error('[mu/delete] delete turns error:', t.error);
      return json({ ok: false, error: 'delete_turns_failed' }, 500);
    }

    // mu_conversations -> id(text) / user_code(text)
    const c = await db
      .from('mu_conversations')
      .delete()
      .eq('user_code', user_code)
      .eq('id', convId);
    if (c.error) {
      console.error('[mu/delete] delete conversation error:', c.error);
      return json({ ok: false, error: 'delete_conv_failed' }, 500);
    }

    return json({ ok: true, id: convId });
  } catch (e: any) {
    console.error('[mu/delete] fatal', e);
    return json({ ok: false, error: 'internal_error', detail: String(e?.message || e) }, 500);
  }
}

export const POST = handler;
export const DELETE = handler;
