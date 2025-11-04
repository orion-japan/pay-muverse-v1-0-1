// src/app/api/payjp/charge/route.ts
export const runtime = 'nodejs';

import { NextRequest, NextResponse } from 'next/server';
import Payjp from 'payjp';
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

// ───────── env / helpers ─────────
function must(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

const payjp = Payjp(must('PAYJP_SECRET_KEY'));
const supa = createClient(must('NEXT_PUBLIC_SUPABASE_URL'), must('SUPABASE_SERVICE_ROLE_KEY'));

// UI改ざん防止：サーバ側で正価を確定
const PRICES = {
  2: Number(process.env.NEXT_PUBLIC_PRICE_P2 ?? 280),
  3: Number(process.env.NEXT_PUBLIC_PRICE_P3 ?? 980),
  4: Number(process.env.NEXT_PUBLIC_PRICE_P4 ?? 1980),
  bundle234: Number(process.env.NEXT_PUBLIC_PRICE_BUNDLE ?? 3180),
} as const;

type Stage = 2 | 3 | 4;

// ───────── main ─────────
/**
 * Body 期待:
 * {
 *   token: string;            // PAY.JPのカードトークン
 *   stage?: 2|3|4;            // 個別解放のとき指定
 *   bundle?: boolean;         // 2〜4一括のとき true
 *   userId: string;           // 必須（ヘッダで渡す場合は body省略可）
 * }
 */
export async function POST(req: NextRequest) {
  try {
    const {
      token,
      stage,
      bundle = false,
      userId: _userId,
    } = (await req.json()) as {
      token: string;
      stage?: Stage;
      bundle?: boolean;
      userId?: string;
    };

    const userId = _userId || req.headers.get('x-user-id') || '';
    if (!token || !userId || (!bundle && !stage)) {
      return NextResponse.json({ ok: false, error: 'bad_request' }, { status: 400 });
    }

    // 価格をサーバ側で確定
    const amount = bundle ? PRICES.bundle234 : PRICES[stage as Stage];
    if (!amount || amount <= 0) {
      return NextResponse.json({ ok: false, error: 'price_not_configured' }, { status: 500 });
    }

    // すでに権利がある場合は課金をスキップ（冪等運用）
    const { data: ent } = await supa
      .from('mui_entitlements')
      .select('bundle,p2,p3,p4')
      .eq('user_id', userId)
      .maybeSingle();

    if (bundle && ent?.bundle) {
      return NextResponse.json({ ok: true, alreadyOwned: true });
    }
    if (!bundle && stage) {
      if ((stage === 2 && ent?.p2) || (stage === 3 && ent?.p3) || (stage === 4 && ent?.p4)) {
        return NextResponse.json({ ok: true, alreadyOwned: true });
      }
    }

    // 課金実行（idempotency key で二重送信防止）
    const idemp = crypto.randomUUID();
    const description = bundle ? 'Muverse フェーズ2〜4 一括解放' : `Muverse フェーズ${stage} 解放`;

    const charge = await payjp.charges.create(
      {
        amount,
        currency: 'jpy',
        card: token,
        capture: true,
        description,
        metadata: { userId, bundle: String(bundle), stage: String(stage ?? '') },
      },
      { idempotency_key: idemp },
    );

    if (charge.paid !== true) {
      return NextResponse.json({ ok: false, error: 'payment_failed' }, { status: 402 });
    }

    // 権利付与（upsert）
    if (bundle) {
      await supa
        .from('mui_entitlements')
        .upsert(
          { user_id: userId, bundle: true, p2: true, p3: true, p4: true },
          { onConflict: 'user_id' },
        );
    } else if (stage === 2) {
      await supa
        .from('mui_entitlements')
        .upsert({ user_id: userId, p2: true }, { onConflict: 'user_id' });
    } else if (stage === 3) {
      await supa
        .from('mui_entitlements')
        .upsert({ user_id: userId, p3: true }, { onConflict: 'user_id' });
    } else if (stage === 4) {
      await supa
        .from('mui_entitlements')
        .upsert({ user_id: userId, p4: true }, { onConflict: 'user_id' });
    }

    // 購入履歴を記録
    await supa.from('purchases').insert({
      user_id: userId,
      provider: 'payjp',
      price_id: bundle ? 'bundle234' : `stage${stage}`,
      status: 'paid',
      amount,
      raw_json: charge, // jsonb列に
    });

    return NextResponse.json({ ok: true, amount, bundle, stage: stage ?? null });
  } catch (e) {
    console.error('[payjp/charge] error', e);
    return NextResponse.json({ ok: false, error: 'server_error' }, { status: 500 });
  }
}
