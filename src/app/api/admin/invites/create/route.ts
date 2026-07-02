// src/app/api/admin/invites/create/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

function randomCode(len = 7) {
  let s = '';
  for (let i = 0; i < len; i++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return s;
}

function clean(v: unknown) {
  return typeof v === 'string' ? v.trim() : '';
}

function buildDestinationUrl(input: {
  ref: string;
  rcode: string;
  mcode: string;
  media_code: string;
  destination_url: string;
}) {
  const base = input.destination_url || 'https://mu-verse.jp/free-mubook/';
  const url = new URL(base);
  if (input.ref) url.searchParams.set('ref', input.ref);
  if (input.rcode) url.searchParams.set('rcode', input.rcode);
  if (input.mcode) url.searchParams.set('mcode', input.mcode);
  if (input.media_code) url.searchParams.set('media_code', input.media_code);
  return url.toString();
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const ref = clean(body.ref);
    const rcode = clean(body.rcode);
    const mcode = clean(body.mcode);
    const media_code = clean(body.media_code || 'AP');
    const label = clean(body.label);
    const memo = clean(body.memo);
    const created_by = clean(body.created_by);
    const destination_type = clean(body.destination_type || 'mubook') || 'mubook';
    const destination_url_input = clean(body.destination_url || 'https://mu-verse.jp/free-mubook/');

    if (!rcode) {
      return NextResponse.json({ ok: false, error: 'rcode は必須です' }, { status: 400 });
    }

    let short_code = clean(body.short_code);
    if (short_code && !/^[A-Za-z0-9_-]{4,32}$/.test(short_code)) {
      return NextResponse.json(
        { ok: false, error: 'short_code は英数字・_・- の4〜32文字にしてください' },
        { status: 400 },
      );
    }

    if (!short_code) {
      for (let i = 0; i < 8; i++) {
        const candidate = randomCode(7);
        const { data, error } = await supabaseAdmin
          .from('invite_links')
          .select('id')
          .eq('short_code', candidate)
          .maybeSingle();
        if (error) throw error;
        if (!data) {
          short_code = candidate;
          break;
        }
      }
    }

    if (!short_code) {
      return NextResponse.json({ ok: false, error: '短縮コード生成に失敗しました' }, { status: 500 });
    }

    const destination_url = buildDestinationUrl({
      ref,
      rcode,
      mcode,
      media_code,
      destination_url: destination_url_input,
    });

    const { data, error } = await supabaseAdmin
      .from('invite_links')
      .insert({
        short_code,
        destination_type,
        destination_url,
        ref: ref || null,
        rcode,
        mcode: mcode || null,
        media_code: media_code || null,
        label: label || null,
        memo: memo || null,
        created_by: created_by || null,
        is_active: true,
      })
      .select('*')
      .single();

    if (error) {
      if (error.code === '23505') {
        return NextResponse.json({ ok: false, error: 'この短縮コードは既に使われています' }, { status: 409 });
      }
      throw error;
    }

    const origin = process.env.NEXT_PUBLIC_JOIN_BASE_URL || 'https://join.muverse.jp';
    return NextResponse.json({
      ok: true,
      invite: data,
      short_url: `${origin.replace(/\/+$/, '')}/i/${short_code}`,
      destination_url,
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || 'unknown error' }, { status: 500 });
  }
}
