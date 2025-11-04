// src/app/api/agent/iros/sidebar/route.ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { verifyFirebaseAndAuthorize, SUPABASE_URL, SERVICE_ROLE } from '@/lib/authz';

const sb = createClient(SUPABASE_URL!, SERVICE_ROLE!);
const __DEV__ = process.env.NODE_ENV !== 'production';
const ALLOW_NOAUTH = process.env.ALLOW_DEV_NOAUTH === '1' || __DEV__;

const json = (data: any, status = 200) =>
  new NextResponse(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Debug-User',
    },
  });

export async function OPTIONS() {
  return json({ ok: true });
}

function safe(e: unknown) {
  const m = (e as any)?.message ?? String(e ?? 'error');
  return __DEV__ ? m : 'internal_error';
}

export async function GET(req: NextRequest) {
  try {
    // 1) 認証（DEVはフォールバック許可）
    const z = await verifyFirebaseAndAuthorize(req);
    let userCode = '';

    if (z.ok && z.allowed && z.user) {
      userCode =
        typeof z.user === 'string' ? z.user : String(z.user?.user_code ?? z.user?.uid ?? '');
    } else if (ALLOW_NOAUTH) {
      // 開発用フォールバック（401や認証未設定でも動かす）
      userCode =
        req.headers.get('x-debug-user') ?? req.nextUrl.searchParams.get('user') ?? 'demo-user';
    } else {
      return json({ ok: false, error: z.error ?? 'forbidden' }, z.status ?? 403);
    }

    // 2) ユーザー情報（テーブル未作成でも落とさない）
    let displayName = 'You';
    let userType = 'member';
    let credits = 0;

    try {
      const { data: u, error } = await sb
        .from('users')
        .select('display_name, nickname, plan_status, role, credits, sofia_credits, mu_credits')
        .eq('user_code', userCode)
        .maybeSingle();

      if (error) throw error;

      if (u) {
        displayName = (u.display_name ?? u.nickname ?? displayName) as string;
        userType = (u.plan_status ?? u.role ?? userType) as string;
        credits =
          typeof u.credits === 'number'
            ? u.credits
            : typeof u.sofia_credits === 'number'
              ? u.sofia_credits
              : typeof u.mu_credits === 'number'
                ? u.mu_credits
                : 0;
      }
    } catch (e) {
      if (__DEV__) console.warn('[sidebar:user]', safe(e));
    }

    const userInfo = {
      id: String(userCode),
      name: String(displayName || 'You'),
      userType: String(userType || 'member'),
      credits: Number(credits || 0),
    };

    // 3) 会話一覧（テーブル未作成でも空配列で返す）
    let conversations: Array<{ id: string; title: string; updated_at: string | null }> = [];
    try {
      const { data: convs, error } = await sb
        .from('iros_conversations')
        .select('id, title, updated_at')
        .eq('user_code', userCode)
        .order('updated_at', { ascending: false })
        .limit(50);

      if (error) throw error;

      conversations = (convs ?? []).map((c: any) => ({
        id: String(c.id),
        title: String(c.title || '無題のセッション'),
        updated_at: c.updated_at ?? null,
      }));
    } catch (e) {
      if (__DEV__) console.warn('[sidebar:convs]', safe(e));
      conversations = [];
    }

    return json({ ok: true, userInfo, conversations }, 200);
  } catch (e) {
    if (__DEV__) console.error('[sidebar:unhandled]', e);
    // 予期せぬ例外でも UI を止めない
    return json(
      {
        ok: true,
        userInfo: { id: 'unknown', name: 'You', userType: 'member', credits: 0 },
        conversations: [],
        _warn: safe(e),
      },
      200,
    );
  }
}
