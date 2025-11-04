// src/lib/notify.ts
export type PushKind = 'ftalk' | 'rtalk' | 'event' | 'live' | 'ai' | 'credit' | 'generic';

export async function sendPushTo(
  user_code: string,
  params: {
    kind?: PushKind;
    title: string;
    body?: string;
    url?: string;
    tag?: string;
    renotify?: boolean;
  },
) {
  if (!user_code) return { ok: false, error: 'user_code required' };

  const res = await fetch(`${process.env.NEXT_PUBLIC_BASE_URL || ''}/api/push/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // kind は consents 連動（未指定なら generic）
    body: JSON.stringify({ user_code, ...params }),
  });

  // サーバ側から使うので失敗時も握りつぶさない
  const json = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, ...json };
}
