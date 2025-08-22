import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic'; // 静的最適化回避

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const VAPID_PUBLIC = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY!;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY!;
const VAPID_SUBJECT = process.env.WEB_PUSH_VAPID_SUBJECT || 'mailto:notice@example.com';

const supabase = createClient(supabaseUrl, serviceRoleKey);

// --- web-push を実行時にのみ初期化 ---
let _webpush: typeof import('web-push') | null = null;
let vapidConfigured = false;

async function getWebpushSafe() {
  if (!_webpush) {
    const mod = await import('web-push');
    // default が無い場合も考慮
    const wp: any = (mod as any).default ?? (mod as any);
    _webpush = wp as typeof import('web-push');
    console.log('[push/send] web-push module loaded');
  }
  if (!vapidConfigured) {
    if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
      console.warn('[push/send] VAPID keys are not set. Push sending is disabled.');
      return null;
    }
    _webpush!.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
    vapidConfigured = true;
    console.log('[push/send] VAPID configured (subject only logged):', VAPID_SUBJECT);
  }
  return _webpush;
}

type Kind =
  | 'ftalk'
  | 'rtalk'
  | 'event'
  | 'live'
  | 'ai'
  | 'credit'
  | 'generic';

type SendBody = {
  user_code: string;         // 受信者
  kind?: Kind;               // 種別（consents判定用）
  title?: string;
  body?: string;
  url?: string;              // クリック遷移先
  tag?: string;              // 重複抑止用
  renotify?: boolean;
  vibration?: boolean | number[]; // 上書きしたい場合（通常は consents で自動）
  icon?: string;
  badge?: string;
  image?: string;
  actions?: { action: string; title: string; icon?: string }[];
};

async function getConsents(user_code: string): Promise<Record<string, any>> {
  const { data, error } = await supabase
    .from('profiles')
    .select('consents')
    .eq('user_code', user_code)
    .maybeSingle();

  if (error) {
    console.error('[push/send] consents fetch failed:', error.message);
    throw new Error('consents fetch failed: ' + error.message);
  }
  console.log('[push/send] consents loaded for user_code=', user_code);
  return (data?.consents || {}) as Record<string, any>;
}

async function getSubscriptions(user_code: string) {
  const { data, error } = await supabase
    .from('push_subscriptions')
    .select('endpoint, p256dh, auth')
    .eq('user_code', user_code);

  if (error) {
    console.error('[push/send] subscriptions fetch failed:', error.message);
    throw new Error('subscriptions fetch failed: ' + error.message);
  }
  console.log('[push/send] subscriptions count=', data?.length ?? 0, 'user_code=', user_code);
  return data || [];
}

async function deleteSubscription(endpoint: string) {
  console.warn('[push/send] deleting invalid subscription (410/404). endpoint suffix=', endpoint.slice(-24));
  await supabase.from('push_subscriptions').delete().eq('endpoint', endpoint);
}

function isKindAllowed(consents: Record<string, any>, kind?: Kind) {
  if (consents.push_enabled === false) return false;

  if (!kind || kind === 'generic') return true;

  const map: Record<Kind, boolean> = {
    ftalk: consents.allow_f_talk !== false,
    rtalk: consents.allow_r_talk !== false,
    event: consents.notify_event !== false,
    live: consents.notify_live !== false,
    ai: consents.notify_ai !== false,
    credit: consents.notify_credit !== false,
    generic: true,
  };
  return map[kind];
}

export async function POST(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const debug = url.searchParams.get('debug') === '1';

    const body = (await req.json()) as SendBody;
    const {
      user_code,
      kind = 'generic',
      title = '通知',
      body: message = '',
      url: clickUrl = '/',
      tag,
      renotify,
      vibration,
      icon,
      badge,
      image,
      actions,
    } = body;

    if (debug) console.log('[push/send] incoming body:', body);

    if (!user_code) {
      return NextResponse.json({ error: 'user_code required' }, { status: 400 });
    }

    // consents 読み込み
    const consents = await getConsents(user_code);

    // 種別許可判定
    if (!isKindAllowed(consents, kind)) {
      console.warn('[push/send] kind disabled by consents:', kind, 'user_code=', user_code);
      return NextResponse.json({ error: `kind "${kind}" disabled by consents` }, { status: 403 });
    }

    // 購読取得
    const subs = await getSubscriptions(user_code);
    if (!subs.length) {
      console.warn('[push/send] no subscription for user_code=', user_code);
      return NextResponse.json({ error: 'no subscription' }, { status: 404 });
    }

    // vibration の最終決定
    const vibrationEnabled =
      typeof vibration !== 'undefined'
        ? vibration
        : consents.vibration !== false;

    // ✅ デフォルト icon / badge を必ず付与
    const payload = {
      title,
      body: message,
      url: clickUrl,
      tag,
      renotify: !!renotify,
      vibration: vibrationEnabled,
      icon: icon || '/pwaicon192.png',
      badge: badge || '/pwaicon512.png',
      image: image || undefined,
      actions: Array.isArray(actions) ? actions.slice(0, 2) : undefined,
    };

    if (debug) console.log('[push/send] payload:', payload);

    // web-push 初期化
    const webpush = await getWebpushSafe();
    if (!webpush) {
      return NextResponse.json(
        { error: 'Server VAPID keys are missing. Set NEXT_PUBLIC_VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY.' },
        { status: 500 }
      );
    }

    const results: Array<{ endpoint: string; ok: boolean; status?: number; error?: string }> = [];

    for (const s of subs) {
      const endpointSuffix = s.endpoint.slice(-24);
      const subscription = {
        endpoint: s.endpoint,
        keys: { p256dh: s.p256dh, auth: s.auth },
      } as any;

      try {
        if (debug) console.log('[push/send] sending ->', endpointSuffix);
        await webpush.sendNotification(subscription, JSON.stringify(payload));
        results.push({ endpoint: s.endpoint, ok: true });
      } catch (err: any) {
        const status = err?.statusCode || err?.status;
        const msg = String(err?.message || err);
        console.error('[push/send] send error:', status, msg, 'endpoint suffix=', endpointSuffix);
        results.push({ endpoint: s.endpoint, ok: false, status, error: msg });

        if (status === 404 || status === 410) {
          await deleteSubscription(s.endpoint);
        }
      }
    }

    if (debug) console.log('[push/send] results:', results.map(r => ({ ok: r.ok, status: r.status, end: r.endpoint.slice(-24) })));

    return NextResponse.json({
      ok: true,
      results,
      ...(debug ? { debug: { subsCount: subs.length, payload } } : {}),
    });
  } catch (e: any) {
    console.error('[push/send] error:', e);
    return NextResponse.json({ error: e?.message || 'server error' }, { status: 500 });
  }
}
