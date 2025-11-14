// src/app/api/shipmates/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin as supabaseServer } from '@/lib/supabaseAdmin';
import { adminAuth } from '@/lib/firebase-admin';

type Plan = 'free' | 'regular' | 'premium' | 'master' | 'admin';

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const owner = searchParams.get('owner');
    if (!owner) return NextResponse.json({ error: 'missing owner' }, { status: 400 });

    // 認証ユーザーのプランを判定（閲覧者のプラン）
    const authHeader = req.headers.get('authorization') || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

    let viewerPlan: Plan = 'free';
    if (token) {
      try {
        const decoded = await adminAuth.verifyIdToken(token, true);
        const { data: userRow } = await supabaseServer
          .from('users')
          .select('user_code, plan_status, click_type, card_registered')
          .eq('firebase_uid', decoded.uid)
          .single();

        // あなたの既存ロジックに合わせて判定
        const ps = (userRow?.plan_status as Plan | null) ?? 'free';
        viewerPlan = ps;
      } catch {
        viewerPlan = 'free';
      }
    }

    const isPaid = viewerPlan !== 'free';

    if (isPaid) {
      // 詳細（課金ユーザー）
      const { data, error } = await supabaseServer.rpc('shipmates_for', { owner_code: owner });
      if (error) throw error;
      return NextResponse.json(data ?? [], { status: 200 });
    } else {
      // サマリー（free：数字のみ）
      const { data, error } = await supabaseServer.rpc('shipmates_summary_for', {
        owner_code: owner,
      });
      if (error) throw error;
      return NextResponse.json({ summary: data ?? [] }, { status: 200 });
    }
  } catch (e: any) {
    console.error('shipmates api error', e?.message || e);
    return NextResponse.json({ error: 'server error' }, { status: 500 });
  }
}
