// src/app/mypage/settings/NotificationSettingsBox.tsx
'use client';

import { useEffect, useState } from 'react';
import { getAuth } from 'firebase/auth';

type Plan = 'free' | 'regular' | 'premium' | 'master' | 'admin';
type Props = { planStatus: Plan };

/* ▼▼ これが無くなっていてエラーになっています：追加してください ▼▼ */
// VAPIDキー(Base64URL)→Uint8Array
function urlBase64ToUint8Array(base64: string) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const base64Safe = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = typeof atob !== 'undefined' ? atob(base64Safe) : Buffer.from(base64Safe, 'base64').toString('binary');
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

// iPhoneでPWA（ホーム画面から起動）かどうか
function isStandalone() {
  if (typeof window === 'undefined') return false;
  return (
    window.matchMedia?.('(display-mode: standalone)')?.matches === true ||
    // iOS Safari 独自フラグ
    (navigator as any).standalone === true
  );
}

/* ...（既存のユーティリティは省略せずこのまま残す）... */

export default function NotificationSettingsBox({ planStatus }: Props) {
  const [perm, setPerm] = useState<NotificationPermission>(
    typeof Notification !== 'undefined' ? Notification.permission : 'default'
  );
  const [endpoint, setEndpoint] = useState<string>('');
  const [platform, setPlatform] = useState<'ios' | 'android' | 'desktop'>('desktop');
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string>('');

  // ★ 追加：consents を状態管理
  const [consents, setConsents] = useState<Record<string, any>>({});

  const append = (m: string) => setLog(prev => (prev ? prev + '\n' + m : m));

  useEffect(() => {
    const ua = navigator.userAgent || '';
    if (/iPhone|iPad|iPod/i.test(ua)) setPlatform('ios');
    else if (/Android/i.test(ua)) setPlatform('android');
    else setPlatform('desktop');
    setPerm(typeof Notification !== 'undefined' ? Notification.permission : 'default');
  }, []);

  async function getSW() {
    const reg =
      (await navigator.serviceWorker.getRegistration()) ??
      (await navigator.serviceWorker.register('/service-worker.js'));
    return reg;
  }

  /* ------------------- 追加：設定の取得＆保存（Authorization 必須） ------------------- */

  // 取得
  async function loadConsents() {
    const auth = getAuth();
    const idToken = await auth.currentUser?.getIdToken(true);
    if (!idToken) throw new Error('unauthenticated');

    const res = await fetch('/api/notification-settings', {
      method: 'GET',
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { Authorization: `Bearer ${idToken}` },
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j?.error || `load failed: ${res.status}`);
    }
    const data = await res.json();
    setConsents(data || {});
    append('consents loaded: ' + JSON.stringify(data));
  }

  // 保存（必要になったら呼ぶ。UIのトグルから呼び出し想定）
  async function saveConsents(patch: Record<string, any>) {
    const auth = getAuth();
    const idToken = await auth.currentUser?.getIdToken(true);
    if (!idToken) throw new Error('unauthenticated');

    const res = await fetch('/api/notification-settings/save', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${idToken}`,
      },
      body: JSON.stringify({ consents: patch }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j?.ok) throw new Error(j?.error || `save failed: ${res.status}`);

    // サーバ側はマージ保存なので、クライアント側も反映
    setConsents(prev => ({ ...prev, ...patch }));
    append('consents saved: ' + JSON.stringify(patch));
  }

  // 初回マウント時に consents を取得
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        await loadConsents();
      } catch (e: any) {
        append('consents load ERROR: ' + (e?.message || e));
      }
    })();
    return () => { alive = false; };
  }, []);

  /* ------------------- ここまで追加 ------------------- */

  // 通知購読登録（既存のまま）
  async function enablePushOnClick() {
    try {
      setBusy(true);
      append('enable start');
      if (!('serviceWorker' in navigator) || !('PushManager' in window))
        throw new Error('このブラウザはプッシュ非対応です');

      if (platform === 'ios' && !isStandalone()) {
        throw new Error('iPhoneは「ホーム画面に追加」したPWAから開いてください');
      }

      const reg = await getSW();
      append('SW ready');

      const p = await Notification.requestPermission();
      setPerm(p);
      if (p !== 'granted') throw new Error('通知が許可されませんでした');

      const vapid = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY!;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapid),
      });
      setEndpoint(sub.endpoint);
      append('subscribed endpoint=' + sub.endpoint);

      const auth = getAuth();
      const user = auth.currentUser;
      if (!user) throw new Error('ログインしてください');
      const idToken = await user.getIdToken();

      const userCode = 'U-DEBUG-001';

      const res = await fetch('/api/register-push', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${idToken}`,
          'x-mu-user-code': userCode,
        },
        body: JSON.stringify(sub),
      });
      const j = await res.json();
      append('register-push: ' + JSON.stringify(j));
      if (!j?.ok) throw new Error(j?.error || 'register failed');

      alert('通知の準備ができました');
    } catch (e: any) {
      append('ERROR ' + (e?.message || e));
      alert(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  // 購読やり直し（既存のまま）
  async function resubscribe() {
    try {
      setBusy(true);
      append('resubscribe start');
      const reg = await getSW();
      const sub = await reg.pushManager.getSubscription();
      if (sub) await sub.unsubscribe();
      append('old subscription cleared');
      await enablePushOnClick();
    } catch (e: any) {
      append('ERROR ' + (e?.message || e));
      alert(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  // テスト送信（そのままでも可。必要なら Authorization を足してください）
  async function sendTest() {
    try {
      setBusy(true);
      append('sendTest start');
      const uid = getAuth().currentUser?.uid;
      if (!uid) throw new Error('先に「通知を有効にする」を押してください');
      const res = await fetch('/api/push-test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          uid,
          title: 'Muverse テスト',
          body: platform === 'ios' ? 'iPhone PWAへ通知テスト' : '通知テスト',
          url: '/self',
          tag: 'muverse',
        }),
      });
      const text = await res.text();
      append('push-test: ' + text);
      alert('送信しました（数秒で表示されます）');
    } catch (e: any) {
      append('ERROR ' + (e?.message || e));
      alert(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  const granted = perm === 'granted';
  const isIOSPWA = platform === 'ios' && isStandalone();

  return (
    <section style={{ border: '1px solid #eee', borderRadius: 12, padding: 16 }}>
      <h3 style={{ marginBottom: 8 }}>通知・公開設定</h3>

      <div style={{ fontSize: 13, color: '#555', marginBottom: 8 }}>
        権限: <b>{perm}</b> / 実行環境: <b>{platform}{platform==='ios' ? (isIOSPWA ? ' (PWA)' : ' (Safari)') : ''}</b>
        {endpoint && (
          <div style={{ marginTop: 4, overflowWrap: 'anywhere' }}>
            endpoint: {endpoint}
          </div>
        )}
      </div>

      {/* 例：consents の一部をトグルで保存（UIはお好みで拡張） */}
      <div style={{ marginBottom: 12 }}>
        <label style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
          <input
            type="checkbox"
            checked={!!consents.push_enabled}
            onChange={(e) => saveConsents({ push_enabled: e.target.checked })}
          />
          プッシュ通知を有効にする（サーバ保存）
        </label>
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        <button onClick={enablePushOnClick} disabled={busy}>
          通知を有効にする
        </button>
        <button onClick={resubscribe} disabled={busy}>
          購読をやり直す
        </button>
        <button onClick={sendTest} disabled={busy || !granted}>
          テスト通知を送る
        </button>
      </div>

      {platform === 'ios' && !isIOSPWA && (
        <div style={{ fontSize: 12, color: '#b35', marginBottom: 8 }}>
          ※ iPhoneは「共有 → ホーム画面に追加」したPWAから開かないと通知は届きません
        </div>
      )}

      <details>
        <summary>ログ</summary>
        <pre style={{ whiteSpace: 'pre-wrap' }}>{log || '—'}</pre>
      </details>
    </section>
  );
}
