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

    const rawText: string = String(body.text ?? body.message ?? '').trim();
    const baseText =
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

    // --- iros_memory_state から最新のラインを1件取得（string/number 両対応） ---
    const selectCols = 'depth_stage, q_primary, self_acceptance, y_level, h_level, phase, spin_loop, spin_step';

    let mem: any = null;
    let memErr: any = null;

    // ① string で試す
    {
      const r = await supa
        .from('iros_memory_state')
        .select(selectCols)
        .eq('user_code', user_code)
        .order('updated_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      mem = r.data;
      memErr = r.error;
    }

    // ② 取れなければ number で再試行
    if (!mem) {
      const n = Number(user_code);
      if (Number.isFinite(n)) {
        const r2 = await supa
          .from('iros_memory_state')
          .select(selectCols)
          .eq('user_code', n as any)
          .order('updated_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        mem = r2.data ?? mem;
        memErr = r2.error ?? memErr;
      }
    }

    if (memErr) {
      console.warn('[future-seed] memory_state warn:', memErr.message);
    }

    // ✅ sysトリガーに確実に乗せる：seed: を必ず先頭に付与
    const text = baseText.startsWith('seed:') ? baseText : `seed: ${baseText}`;

    // --- meta を組み立て（デモ用に“確実に”IT寄りへ） ---
    const meta: IrosMeta = {
      mode: 'mirror',

      // mem があれば尊重、なければ SeedはT2に固定
      depth: ((mem?.depth_stage as Depth | undefined) ?? 'T2') as Depth,

      // mem があれば尊重、なければ SeedはQ3に寄せる（ギア上げ）
      qCode: ((mem?.q_primary as QCode | undefined) ?? 'Q3') as QCode,

      selfAcceptance:
        typeof mem?.self_acceptance === 'number' ? mem.self_acceptance : 0.5,

      yLevel: typeof mem?.y_level === 'number' ? mem.y_level : undefined,
      hLevel: typeof mem?.h_level === 'number' ? mem.h_level : undefined,

      phase:
        typeof mem?.phase === 'string'
          ? (mem.phase === 'Inner' ? 'Inner' : mem.phase === 'Outer' ? 'Outer' : undefined)
          : undefined,

      spinLoop:
        typeof mem?.spin_loop === 'string' ? mem.spin_loop : 'TCF', // Seedは下降系でもOK
      spinStep:
        typeof mem?.spin_step === 'number' ? mem.spin_step : 0,

      // ✅ sys 側の “demoForceILayer” に乗せる
      demoForceILayer: true,

      // 既に system.ts にあるキーも活用（使う側がいれば効く）
      tLayerHint: 'T2',
      hasFutureMemory: true,
    };

    const out = await generateIrosReply({
      text,
      meta,
      history: [],
    });

    return json({
      ok: true,
      route: 'api/agent/iros/future-seed',
      agent: 'iros',
      user_code,
      reply: out.text,
      meta,
      debug: {
        memFound: !!mem,
        memDepth: mem?.depth_stage ?? null,
        memQ: mem?.q_primary ?? null,
      },
    });
  } catch (e: any) {
    console.error('[future-seed] error', e);
    return json(
      { ok: false, error: 'internal_error', detail: String(e?.message || e) },
      500,
    );
  }
}
