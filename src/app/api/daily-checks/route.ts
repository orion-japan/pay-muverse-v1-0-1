// src/app/api/daily-checks/route.ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

/** Supabase(SR) */
const SUPABASE_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE =
  process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_SERVICE_ROLE_KEY!;
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);

/** 取得に使うカラム */
const SELECT_COLS =
  'id,user_code,vision_id,check_date,vision_imaged,resonance_shared,status_text,diary_text,progress,q_code,is_final,created_at,updated_at';

/* ===== JST utilities ===== */
function todayJstYmd(): string {
  const s = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  const [y, m, d] = s.split('/');
  return `${y}-${m}-${d}`;
}
function toJstYmd(d: Date): string {
  const s = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
  const [y, m, dd] = s.split('/');
  return `${y}-${m}-${dd}`;
}
function jstYmdDaysAgo(daysAgo: number): string {
  const nowJst = Date.now() + 9 * 60 * 60 * 1000;
  const dayMs = 24 * 60 * 60 * 1000;
  return toJstYmd(new Date(nowJst - daysAgo * dayMs));
}

/* ===== GET ===== */
export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const isHistory = url.searchParams.get('history') === '1';

    const user_code = url.searchParams.get('user_code') || '';
    const vision_id = url.searchParams.get('vision_id') || '';
    if (!user_code || !vision_id) {
      return NextResponse.json({ error: 'missing user_code or vision_id' }, { status: 400 });
    }

    if (isHistory) {
      const daysParam = Number(url.searchParams.get('days') || 14);
      const days = Number.isFinite(daysParam) ? Math.max(1, Math.min(60, Math.floor(daysParam))) : 14;

      const toStr = todayJstYmd();
      const fromStr = jstYmdDaysAgo(days - 1);

      const { data, error } = await supabase
        .from('daily_checks')
        .select('check_date,progress,vision_imaged,resonance_shared')
        .eq('user_code', user_code)
        .eq('vision_id', vision_id)
        .gte('check_date', fromStr)
        .lte('check_date', toStr)
        .order('check_date', { ascending: true });

      if (error) throw error;
      return NextResponse.json({ data: data ?? [] });
    }

    // today (JST) fallback
    const date = url.searchParams.get('date') || todayJstYmd();

    const { data, error } = await supabase
      .from('daily_checks')
      .select(SELECT_COLS)
      .eq('user_code', user_code)
      .eq('vision_id', vision_id)
      .eq('check_date', date)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error && (error as any).code !== 'PGRST116') throw error;
    return NextResponse.json({ data: data ?? null });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'internal error' }, { status: 500 });
  }
}

/* ===== POST ===== */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      user_code,
      vision_id,
      date, // optional JST 'YYYY-MM-DD'
      vision_imaged = false,
      resonance_shared = false,
      status_text = null,
      diary_text = null,
      progress = 0,
      q_code = null,
    } = body || {};

    if (!user_code || !vision_id) {
      return NextResponse.json({ error: 'missing user_code or vision_id' }, { status: 400 });
    }

    const check_date: string = date || todayJstYmd();

    const { data: existing, error: e1 } = await supabase
      .from('daily_checks')
      .select('id')
      .eq('user_code', user_code)
      .eq('vision_id', vision_id)
      .eq('check_date', check_date)
      .order('updated_at', { ascending: false })
      .limit(1);

    if (e1) throw e1;

    const nowIso = new Date().toISOString();
    const payload = {
      user_code,
      vision_id,
      check_date,
      vision_imaged,
      resonance_shared,
      status_text,
      diary_text,
      progress,
      q_code,
      is_final: false,
      updated_at: nowIso,
    };

    let saved: any = null;

    if (existing && existing.length > 0) {
      const id = existing[0].id;
      const { data, error } = await supabase
        .from('daily_checks')
        .update(payload)
        .eq('id', id)
        .select(SELECT_COLS)
        .maybeSingle();
      if (error) throw error;
      saved = data;
    } else {
      const { data, error } = await supabase
        .from('daily_checks')
        .insert({ ...payload, created_at: nowIso })
        .select(SELECT_COLS)
        .maybeSingle();
      if (error) throw error;
      saved = data;
    }

    return NextResponse.json({ ok: true, data: saved });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'internal error' }, { status: 500 });
  }
}
