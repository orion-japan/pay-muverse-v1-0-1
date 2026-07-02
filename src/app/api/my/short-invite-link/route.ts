// src/app/api/my/short-invite-link/route.ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { adminAuth } from '@/lib/firebase-admin';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

function clean(v: unknown) {
  return typeof v === 'string' ? v.trim() : '';
}

function randomCode(len = 9) {
  let s = '';
  for (let i = 0; i < len; i++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return s;
}

function shortUrl(code: string) {
  const origin = process.env.NEXT_PUBLIC_JOIN_BASE_URL || 'https://join.muverse.jp';
  return `${origin.replace(/\/+$/, '')}/i/${code}`;
}

function isLegacyExposedCode(code?: string | null) {
  // 旧実装で rcode/user_code が見えてしまう u-669933 形式を破棄する
  return !!code && /^u-[A-Za-z0-9_-]+$/i.test(code);
}

async function createUniqueShortCode() {
  for (let i = 0; i < 12; i++) {
    const candidate = randomCode(9);
    const { data, error } = await supabaseAdmin
      .from('invite_links')
      .select('id')
      .eq('short_code', candidate)
      .maybeSingle();
    if (error) throw error;
    if (!data) return candidate;
  }
  throw new Error('short code generation failed');
}

export async function POST(req: Request) {
  try {
    const authHeader = req.headers.get('authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
    }

    const decoded = await adminAuth.verifyIdToken(authHeader.slice('Bearer '.length).trim()).catch(() => null);
    if (!decoded?.uid) {
      return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const destination_url = clean(body.destination_url);
    const media_code = clean(body.media_code || 'AP') || 'AP';

    if (!destination_url || !/^https?:\/\//i.test(destination_url)) {
      return NextResponse.json({ ok: false, error: 'destination_url is required' }, { status: 400 });
    }

    const { data: user, error: userErr } = await supabaseAdmin
      .from('users')
      .select('user_code, rcode, mcode')
      .eq('firebase_uid', decoded.uid)
      .maybeSingle();

    if (userErr) throw userErr;
    if (!user?.user_code) {
      return NextResponse.json({ ok: false, error: 'user not found' }, { status: 404 });
    }

    const rcode = clean(body.rcode) || clean(user.rcode) || clean(user.user_code);
    const mcode = clean(body.mcode) || clean(user.mcode);
    const ref = clean(body.ref);
    const label = clean(body.label || 'MyPage 招待リンク');
    const memo = clean(body.memo || 'auto generated from mypage');

    const { data: existing, error: existingErr } = await supabaseAdmin
      .from('invite_links')
      .select('*')
      .eq('destination_type', 'personal_invite')
      .eq('created_by', user.user_code)
      .eq('media_code', media_code)
      .maybeSingle();

    if (existingErr) throw existingErr;

    if (existing?.short_code && !isLegacyExposedCode(existing.short_code)) {
      const { data: updated, error: updateErr } = await supabaseAdmin
        .from('invite_links')
        .update({
          destination_url,
          ref: ref || null,
          rcode: rcode || null,
          mcode: mcode || null,
          media_code,
          label,
          memo,
          is_active: true,
          updated_at: new Date().toISOString(),
        })
        .eq('id', existing.id)
        .select('*')
        .single();
      if (updateErr) throw updateErr;
      return NextResponse.json({ ok: true, invite: updated, short_url: shortUrl(updated.short_code) });
    }

    const short_code = await createUniqueShortCode();

    if (existing?.id && isLegacyExposedCode(existing.short_code)) {
      const { data: regenerated, error: regenerateErr } = await supabaseAdmin
        .from('invite_links')
        .update({
          short_code,
          destination_url,
          ref: ref || null,
          rcode: rcode || null,
          mcode: mcode || null,
          media_code,
          label,
          memo,
          is_active: true,
          updated_at: new Date().toISOString(),
        })
        .eq('id', existing.id)
        .select('*')
        .single();
      if (regenerateErr) throw regenerateErr;
      return NextResponse.json({ ok: true, invite: regenerated, short_url: shortUrl(regenerated.short_code) });
    }

    const { data: inserted, error: insertErr } = await supabaseAdmin
      .from('invite_links')
      .insert({
        short_code,
        destination_type: 'personal_invite',
        destination_url,
        ref: ref || null,
        rcode: rcode || null,
        mcode: mcode || null,
        media_code,
        label,
        memo,
        created_by: user.user_code,
        is_active: true,
      })
      .select('*')
      .single();

    if (insertErr) throw insertErr;

    return NextResponse.json({ ok: true, invite: inserted, short_url: shortUrl(inserted.short_code) });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || 'unknown error' }, { status: 500 });
  }
}
