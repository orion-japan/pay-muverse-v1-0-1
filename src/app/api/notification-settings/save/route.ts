// src/app/api/notification-settings/save/route.ts
import { NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// --- utils -------------------------------------------------------------

async function uidToUserCode(uid: string): Promise<string> {
  const { data, error } = await supabase
    .from('users')
    .select('user_code')
    .eq('firebase_uid', uid)
    .maybeSingle();
  if (error || !data?.user_code) throw new Error('user_code not found');
  return data.user_code as string;
}

const ALLOWED_KEYS = [
  'push_enabled',
  'vibration',
  'notify_self_talk',
  'notify_i_board',
  'allow_f_talk',
  'allow_r_talk',
  'notify_event',
  'notify_live',
  'notify_ai',
  'notify_credit',
] as const;
type ConsentKey = typeof ALLOWED_KEYS[number];

const SELF_RANGES = new Set(['all', 'friends', 'none']);

function toBool(v: unknown): boolean | undefined {
  if (v === true || v === false) return v;
  if (v === 'true' || v === '1' || v === 1) return true;
  if (v === 'false' || v === '0' || v === 0) return false;
  return undefined;
}

function sanitizeIncoming(input: Record<string, any>): Partial<Record<ConsentKey, any>> {
  const out: Partial<Record<ConsentKey, any>> = {};
  for (const k of ALLOWED_KEYS) {
    const v = input[k];
    if (v === undefined) continue;

    if (k === 'notify_self_talk' || k === 'notify_i_board') {
      if (typeof v === 'string' && SELF_RANGES.has(v)) {
        out[k] = v;
      }
      continue;
    }

    // boolean fields
    const b = toBool(v);
    if (b !== undefined) out[k] = b;
  }
  return out;
}

// --- handler -----------------------------------------------------------

export async function POST(req: Request) {
  try {
    let body: any;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'invalid json' }, { status: 400 });
    }

    // user identification: prefer user_code, else uid
    const user_code: string | undefined =
      typeof body.user_code === 'string' && body.user_code.trim()
        ? body.user_code.trim()
        : undefined;

    const uid: string | undefined =
      typeof body.uid === 'string' && body.uid.trim() ? body.uid.trim() : undefined;

    if (!user_code && !uid) {
      return NextResponse.json({ error: 'uid or user_code required' }, { status: 400 });
    }

    const targetUserCode = user_code ?? (await uidToUserCode(uid!));

    // payload may be {consents:{...}} or keys at top-level
    const rawConsents: Record<string, any> =
      typeof body.consents === 'object' && body.consents
        ? body.consents
        : body;

    const incoming = sanitizeIncoming(rawConsents);

    if (Object.keys(incoming).length === 0) {
      return NextResponse.json({ error: 'no consent fields' }, { status: 400 });
    }

    // read current consents
    const { data: prof, error: selErr } = await supabase
      .from('profiles')
      .select('consents')
      .eq('user_code', targetUserCode)
      .maybeSingle();
    if (selErr) throw selErr;

    const current = (prof?.consents ?? {}) as Record<string, any>;
    const merged = { ...current, ...incoming };

    if (!prof) {
      // row does not exist → insert
      const { error: insErr } = await supabase
        .from('profiles')
        .insert([{ user_code: targetUserCode, consents: merged, updated_at: new Date().toISOString() }]);
      if (insErr) throw insErr;
    } else {
      // row exists → update
      const { error: upErr } = await supabase
        .from('profiles')
        .update({ consents: merged, updated_at: new Date().toISOString() })
        .eq('user_code', targetUserCode);
      if (upErr) throw upErr;
    }

    return NextResponse.json({
      ok: true,
      user_code: targetUserCode,
      consents: merged,
    });
  } catch (e: any) {
    console.error('[notification-settings/save] error:', e);
    return NextResponse.json(
      { error: typeof e?.message === 'string' ? e.message : 'server error' },
      { status: 500 }
    );
  }
}
