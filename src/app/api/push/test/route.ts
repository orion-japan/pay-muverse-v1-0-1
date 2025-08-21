// src/app/api/push/test/route.ts
import { NextResponse } from 'next/server';
import { getWebpush, hasVapidKeys } from '@/lib/webpush';

export const dynamic = 'force-dynamic'; // 収集フェーズでの実行を避ける
// export const runtime = 'nodejs'; // 必要なら明示

export async function GET() {
  // ビルド時に throw させない：キーが無ければ 200 で状態を返すだけ
  const hasKeys = hasVapidKeys();

  // 実行時にのみ初期化（トップレベル禁止）
  const webpush = await getWebpush(); // キー無しなら null を返す仕様
  const configured = Boolean(webpush);

  return NextResponse.json({
    ok: true,
    hasVapidKeys: hasKeys,
    configured,
    note:
      hasKeys
        ? 'webpush is ready at runtime.'
        : 'VAPID keys are missing. Set NEXT_PUBLIC_VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY.',
  });
}
