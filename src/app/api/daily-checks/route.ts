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

/** ---- GET: 今日分 or 履歴 ----
 *  /api/daily-checks?user_code=...&vision_id=...&date=YYYY-MM-DD
 *  /api/daily-checks?history=1&days=14&user_code=...&vision_id=...
 */
export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const isHistory = url.searchParams.get('history') === '1';

    const user_code = url.searchParams.get('user_code') || '';
    const vision_id = url.searchParams.get('vision_id') || '';
    if (!user_code || !vision_id) {
      return NextResponse.json(
        { error: 'missing user_code or vision_id' },
        { status: 400 }
      );
    }

    if (isHistory) {
      const days = Math.max(1, Math.min(60, Number(url.searchParams.get('days') || 14)));
      // 直近 days 日（本日含む）を返す
      const today = new Date();
      const from = new Date(today);
      from.setDate(today.getDate() - (days - 1));

      const fromStr = from.toISOString().slice(0, 10); // YYYY-MM-DD
      const toStr = today.toISOString().slice(0, 10);

      const { data, error } = await supabase
        .from('daily_checks')
        .select('check_date,progress,vision_imaged,resonance_shared')
        .eq('user_code', user_code)
        .eq('vision_id', vision_id)
        .gte('check_date', fromStr)
        .lte('check_date', toStr)
        .order('check_date', { ascending: true });

      if (error) throw error;

      return NextResponse.json({
        data: data ?? [],
      });
    }

    // 今日分（date 指定）を返す：最新更新を1件
    const date = url.searchParams.get('date');
    if (!date) {
      return NextResponse.json(
        { error: 'missing date' },
        { status: 400 }
      );
    }

    const { data, error } = await supabase
      .from('daily_checks')
      .select(SELECT_COLS)
      .eq('user_code', user_code)
      .eq('vision_id', vision_id)
      .eq('check_date', date)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error && error.code !== 'PGRST116') throw error;

    return NextResponse.json({
      data: data ?? null,
    });
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message || 'internal error' },
      { status: 500 }
    );
  }
}

/** ---- POST: 保存（自動保存/手動保存とも is_final=false 固定） ----
 * body: {
 *   user_code, vision_id, date(YYYY-MM-DD),
 *   vision_imaged, resonance_shared, status_text, diary_text,
 *   progress, q_code
 * }
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      user_code,
      vision_id,
      date, // check_date
      vision_imaged = false,
      resonance_shared = false,
      status_text = null,
      diary_text = null,
      progress = 0,
      q_code = null,
    } = body || {};

    if (!user_code || !vision_id || !date) {
      return NextResponse.json(
        { error: 'missing user_code, vision_id or date' },
        { status: 400 }
      );
    }

    // 既存行があれば更新、無ければ作成（当日1件ルール）
    const { data: existing, error: e1 } = await supabase
      .from('daily_checks')
      .select('id')
      .eq('user_code', user_code)
      .eq('vision_id', vision_id)
      .eq('check_date', date)
      .order('updated_at', { ascending: false })
      .limit(1);

    if (e1) throw e1;

    const payload = {
      user_code,
      vision_id,
      check_date: date,
      vision_imaged,
      resonance_shared,
      status_text,
      diary_text,
      progress,
      q_code,
      is_final: false, // ★ 固定
      updated_at: new Date().toISOString(),
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
        .insert({ ...payload, created_at: new Date().toISOString() })
        .select(SELECT_COLS)
        .maybeSingle();
      if (error) throw error;
      saved = data;
    }

    return NextResponse.json({ ok: true, data: saved });
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message || 'internal error' },
      { status: 500 }
    );
  }
}
