// src/app/api/agent/iros/future-seed/route.ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import {
  SUPABASE_URL,
  SERVICE_ROLE,
  verifyFirebaseAndAuthorize,
} from '@/lib/authz';

import { generateIrosReply } from '@/lib/iros/generate';
import type { IrosMeta, Depth, QCode } from '@/lib/iros/system';

function json(data: any, init?: number | ResponseInit) {
  const status =
    typeof init === 'number'
      ? init
      : ((init as ResponseInit | undefined)?.['status'] ?? 200);
  const headers = new Headers(
    typeof init === 'number'
      ? undefined
      : (init as ResponseInit | undefined)?.headers,
  );
  headers.set('Content-Type', 'application/json; charset=utf-8');
  return new NextResponse(JSON.stringify(data), { status, headers });
}

export async function POST(req: NextRequest) {
  try {
    // --- 認証 ---
    const auth = await verifyFirebaseAndAuthorize(req as any);
    if (!auth?.ok)
      return json(
        { ok: false, error: auth?.error || 'unauthorized' },
        auth?.status || 401,
      );
    if (!auth.allowed) return json({ ok: false, error: 'forbidden' }, 403);

    // --- 入力 ---
    const body = (await req.json().catch(() => ({}))) as any;

    // ★ text は任意：空なら内部トリガー文に差し替える
    const rawText: string = String(body.text ?? body.message ?? '').trim();
    const text: string =
      rawText ||
      'いまの私の流れと、これから数ヶ月の未来Seedを教えてください。';

    const user_code: string | null =
      (body.user_code as string | undefined) ??
      auth.userCode ??
      auth.user?.user_code ??
      null;
    if (!user_code) return json({ ok: false, error: 'no_user_code' }, 401);

    const supa = createClient(SUPABASE_URL!, SERVICE_ROLE!, {
      auth: { persistSession: false },
    });

    // --- iros_memory_state から最新のラインを1件取得 ---
    const { data: mem, error: memErr } = await supa
      .from('iros_memory_state')
      .select(
        'depth_stage, q_primary, self_acceptance, y_level, h_level',
      )
      .eq('user_code', user_code)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (memErr) {
      console.warn('[future-seed] memory_state warn:', memErr.message);
    }

    // --- meta を組み立て（必要最小限 + T層起動） ---
    const meta: IrosMeta & {
      tLayerModeActive?: boolean;
      tLayerHint?: string;
    } = {
      mode: 'mirror',
      depth: (mem?.depth_stage as Depth | undefined) ?? undefined,
      qCode: (mem?.q_primary as QCode | undefined) ?? undefined,
      selfAcceptance:
        typeof mem?.self_acceptance === 'number'
          ? mem.self_acceptance
          : undefined,
      yLevel:
        typeof mem?.y_level === 'number' ? mem.y_level : undefined,
      hLevel:
        typeof mem?.h_level === 'number' ? mem.h_level : undefined,
      // ★ ここで「未来Seedモード」をオンにする
      tLayerModeActive: true,
      tLayerHint: 'T2',
    };

    // --- iros 本体に、未来Seedモードで1ターンだけ生成させる ---
    const out = await generateIrosReply({
      text,
      meta,
      history: [], // 未来Seed用なので履歴は一旦オフ（必要になったら追加）
    });

    return json({
      ok: true,
      route: 'api/agent/iros/future-seed',
      agent: 'iros',
      user_code,
      reply: out.text,
      meta,
    });
  } catch (e: any) {
    console.error('[future-seed] error', e);
    return json(
      { ok: false, error: 'internal_error', detail: String(e?.message || e) },
      500,
    );
  }
}
