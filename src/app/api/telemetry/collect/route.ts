// src/app/api/telemetry/collect/route.ts
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
// 任意: 将来ログしたくなったら↓を使う
// import { supabaseAdmin } from '@/lib/supabaseAdmin';
// import { adminAuth } from '@/lib/firebase-admin';

const TELEMETRY_ENABLED = process.env.TELEMETRY_ENABLED === '1'; // 環境変数でON/OFF

export async function POST(req: Request) {
  try {
    // すぐ静かにしたい場合は完全ノーオペ
    if (!TELEMETRY_ENABLED) {
      return new NextResponse(null, { status: 204 }); // No Content
    }

    // --- ここから先は将来ONにした時用の安全実装例 ---
    const ua = req.headers.get('user-agent') || '';
    const body = await req.json().catch(() => ({}));
    const { name, path, meta } = body || {};

    // 認証が必要ならここで検証（任意）
    // const authHeader = req.headers.get('authorization');
    // const idToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : '';
    // const decoded = idToken ? await adminAuth.verifyIdToken(idToken).catch(() => null) : null;
    // const uid = decoded?.uid ?? null;

    // DBに書く場合の雛形（存在しなくても例外で落ちないように）
    // try {
    //   await supabaseAdmin.from('telemetry_event').insert({
    //     name: name ?? null,
    //     path: path ?? null,
    //     ua,
    //     // uid,
    //     meta: meta ?? null,
    //   });
    // } catch (e) {
    //   // ログに残すだけで成功扱いにする
    //   console.warn('[telemetry] insert skipped:', e);
    // }

    return new NextResponse(null, { status: 204 });
  } catch {
    // 何があってもエラーを表に出さない
    return new NextResponse(null, { status: 204 });
  }
}
