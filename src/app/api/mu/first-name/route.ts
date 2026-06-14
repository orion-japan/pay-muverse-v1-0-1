import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import {
  normalizeAuthz,
  SERVICE_ROLE,
  SUPABASE_URL,
  verifyFirebaseAndAuthorize,
} from '@/lib/authz';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function normalizeName(input: unknown): string {
  return String(input || '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 40);
}

export async function POST(req: NextRequest) {
  const authzRaw = await verifyFirebaseAndAuthorize(req);
  const authz = normalizeAuthz(authzRaw);
  const userCode = authz.user?.user_code;

  if (authz.error || !userCode) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const name = normalizeName(body?.name);

  if (!name) {
    return NextResponse.json({ ok: false, error: 'missing_name' }, { status: 400 });
  }

  const sb = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

  const { error } = await sb
    .from('users')
    .update({
      name,
      click_username: name,
    })
    .eq('user_code', userCode);

  if (error) {
    console.warn('[mu-first-name] update failed:', error.message);
    return NextResponse.json({ ok: false, error: 'update_failed' }, { status: 500 });
  }

  return NextResponse.json({ ok: true, name });
}
