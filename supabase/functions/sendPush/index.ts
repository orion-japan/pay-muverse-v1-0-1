/// <reference lib="deno.ns" />
// @ts-nocheck
import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import webpush from 'npm:web-push@3';

// 明示的にヘッダーを列挙（* をやめる）
function cors(origin: string | null) {
  const allowOrigin = origin ?? '*';
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers':
      'content-type, authorization, apikey, x-client-info, x-client-name, x-client-version',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

serve(async (req) => {
  const origin = req.headers.get('Origin');
  const CORS = cors(origin);

  if (req.method === 'OPTIONS') {
    return new Response('ok', { status: 200, headers: CORS });
  }

  if (req.method === 'GET') {
    return new Response('sendPush alive (public)', { status: 200, headers: CORS });
  }

  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405, headers: CORS });
  }

  try {
    const { subscription, payload } = await req.json();
    console.log('[sendPush] subscription:', subscription);
    console.log('[sendPush] payload:', payload);

    if (!subscription || !payload) {
      return new Response('Missing subscription or payload', { status: 400, headers: CORS });
    }

    const PUB  = Deno.env.get('VAPID_PUBLIC_KEY');
    const PRIV = Deno.env.get('VAPID_PRIVATE_KEY');
    const MAIL = Deno.env.get('ADMIN_MAILTO') || 'mailto:admin@example.com';
    if (!PUB || !PRIV) {
      console.error('[sendPush] VAPID keys are not set');
      return new Response('VAPID keys are not set', { status: 500, headers: CORS });
    }

    webpush.setVapidDetails(MAIL, PUB, PRIV);

    try {
      await webpush.sendNotification(subscription, JSON.stringify(payload));
      console.log('[sendPush] sendNotification OK');
    } catch (err) {
      console.error('[sendPush] sendNotification error:', err);
      throw err;
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...CORS },
    });
  } catch (e) {
    console.error('[sendPush] error:', e);
    return new Response(`sendPush error: ${e?.message ?? e}`, { status: 500, headers: CORS });
  }
});
