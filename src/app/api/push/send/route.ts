import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import webpush from 'web-push';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const VAPID_PUBLIC = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY!;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY!;

const supabase = createClient(supabaseUrl, serviceRoleKey);

webpush.setVapidDetails(
  'mailto:notice@example.com',
  VAPID_PUBLIC,
  VAPID_PRIVATE
);

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

  if (error) throw new Error('consents fetch failed: ' + error.message);
  return (data?.consents || {}) as Record<string, any>;
}

async function getSubscriptions(user_code: string) {
  const { data, error } = await supabase
    .from('push_subscriptions')
    .select('endpoint, p256dh, auth')
    .eq('user_code', user_code);

  if (error) throw new Error('subscriptions fetch failed: ' + error.message);
  return data || [];
}

async function deleteSubscription(endpoint: string) {
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
    const body = (await req.json()) as SendBody;
    const {
      user_code,
      kind = 'generic',
      title = '通知',
      body: message = '',
      url = '/',
      tag,
      renotify,
      vibration,
      icon,
      badge,
      image,
      actions,
    } = body;

    if (!user_code) {
      return NextResponse.json({ error: 'user_code required' }, { status: 400 });
    }

    // consents 読み込み
    const consents = await getConsents(user_code);

    // 種別許可判定
    if (!isKindAllowed(consents, kind)) {
      return NextResponse.json({ error: `kind "${kind}" disabled by consents` }, { status: 403 });
    }

    // 購読取得
    const subs = await getSubscriptions(user_code);
    if (!subs.length) {
      return NextResponse.json({ error: 'no subscription' }, { status: 404 });
    }

    // vibration の最終決定（リクエストで上書き可。デフォは consents.vibration !== false）
    const vibrationEnabled =
      typeof vibration !== 'undefined'
        ? vibration
        : consents.vibration !== false;

    const payload = {
      title,
      body: message,
      url,
      tag,
      renotify: !!renotify,
      vibration: vibrationEnabled,
      icon: icon || undefined,
      badge: badge || undefined,
      image: image || undefined,
      actions: Array.isArray(actions) ? actions.slice(0, 2) : undefined,
    };

    const results: Array<{ endpoint: string; ok: boolean; status?: number; error?: string }> = [];

    for (const s of subs) {
      const subscription = {
        endpoint: s.endpoint,
        keys: { p256dh: s.p256dh, auth: s.auth },
      } as webpush.PushSubscription;

      try {
        await webpush.sendNotification(subscription, JSON.stringify(payload));
        results.push({ endpoint: s.endpoint, ok: true });
      } catch (err: any) {
        // ステータス取得（型の都合でany扱い）
        const status = err?.statusCode || err?.status;
        results.push({ endpoint: s.endpoint, ok: false, status, error: String(err) });

        // 410/404 は購読無効なのでクリーンアップ
        if (status === 404 || status === 410) {
          await deleteSubscription(s.endpoint);
        }
      }
    }

    return NextResponse.json({ ok: true, results });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'server error' }, { status: 500 });
  }
}
