// src/lib/webpush.ts
// web-push の安全なシングルトン初期化（CJS/ESMの差異にも対応）

const VAPID_PUBLIC = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY!;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY!;
const VAPID_SUBJECT = process.env.WEB_PUSH_VAPID_SUBJECT || 'mailto:notice@example.com';

let _webpush: typeof import('web-push') | null = null;
let _configured = false;

export async function getWebpush() {
  if (!_webpush) {
    const mod = await import('web-push');
    // default が無い場合にも対応
    const wp: any = (mod as any).default ?? (mod as any);
    _webpush = wp as typeof import('web-push');
  }
  if (!_configured) {
    if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
      // ここで throw しない：呼び出し側で 500 を返す
      console.warn('[webpush] VAPID keys are not set. Push disabled.');
      return null;
    }
    _webpush!.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
    _configured = true;
  }
  return _webpush;
}

export function hasVapidKeys() {
  return Boolean(VAPID_PUBLIC && VAPID_PRIVATE);
}
