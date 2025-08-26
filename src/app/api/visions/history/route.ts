// src/app/api/visions/history/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY! // Server専用
);

// 取得対象のステータス
const HISTORY_STATUSES = ['達成', '保留', '意図チェンジ', '破棄'];

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const userCode =
      req.headers.get('x-user-code') ||
      url.searchParams.get('user_code') ||
      ''; // 必要に応じて認証連携に置換

    if (!userCode) {
      return NextResponse.json({ error: 'missing user_code' }, { status: 401 });
    }

    // 任意：status フィルタ（?status=達成 等）
    const status = url.searchParams.get('status');

    let query = supabase
      .from('visions')
      .select(
        'vision_id,title,status,phase,ended_at,q_code,supersedes_vision_id,superseded_by_id,iboard_thumb'
      )
      .eq('user_code', userCode)
      .in('status', HISTORY_STATUSES)
      .order('ended_at', { ascending: false });

    if (status) query = query.eq('status', status);

    const { data, error } = await query;
    if (error) throw error;

    return NextResponse.json({ items: data ?? [] });
  } catch (e: any) {
    console.error('[history] error', e);
    return NextResponse.json({ error: e?.message || 'server error' }, { status: 500 });
  }
}
