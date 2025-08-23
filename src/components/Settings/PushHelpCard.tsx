'use client';

import { useEffect, useMemo, useState } from 'react';
import { registerPush } from '@/utils/push';
import { useAuth } from '@/context/AuthContext';

function isAndroidChrome() {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent.toLowerCase();
  return ua.includes('android') && ua.includes('chrome') && !ua.includes('edg');
}

export default function PushHelpCard() {
  const { userCode } = useAuth();
  const [perm, setPerm] = useState<NotificationPermission | 'unsupported'>('default');
  const [subscribed, setSubscribed] = useState<boolean | null>(null);
  const onAndroidChrome = useMemo(isAndroidChrome, []);

  useEffect(() => {
    if (typeof Notification === 'undefined') {
      setPerm('unsupported');
    } else {
      setPerm(Notification.permission);
    }

    (async () => {
      if (!('serviceWorker' in navigator)) {
        setSubscribed(null);
        return;
      }
      try {
        const reg = await navigator.serviceWorker.getRegistration();
        const sub = await reg?.pushManager.getSubscription();
        setSubscribed(!!sub);
      } catch {
        setSubscribed(null);
      }
    })();
  }, []);

  const askPermission = async () => {
    if (typeof Notification === 'undefined') return;
    try {
      const p = await Notification.requestPermission();
      setPerm(p);
    } catch {}
  };

  const reSubscribe = async () => {
    if (!userCode) return;
    try {
      await registerPush(userCode);
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = await reg?.pushManager.getSubscription();
      setSubscribed(!!sub);
      alert('購読を再登録しました');
    } catch (e) {
      alert('購読の再登録に失敗しました');
      console.error(e);
    }
  };

  const sendTest = async () => {
    if (!userCode) return;
    try {
      await fetch('/api/push/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_code: userCode,
          kind: 'rtalk',
          title: 'テスト通知',
          body: '通知の受信テストです',
          url: '/',
          tag: 'debug-to-phone',
          renotify: true,
        }),
      });
      alert('テスト通知を送信しました（OS側の表示を確認してください）');
    } catch (e) {
      console.error(e);
    }
  };

  return (
    <section style={{ border: '1px solid #eee', borderRadius: 12, padding: 16, marginTop: 16 }}>
      <h3 style={{ margin: '0 0 8px' }}>プッシュ通知の受信設定</h3>
      <div style={{ fontSize: 14, lineHeight: 1.6 }}>
        <div>ブラウザ権限：<strong>{perm === 'unsupported' ? '未対応' : perm}</strong></div>
        <div>購読状態：<strong>{subscribed === null ? '不明' : subscribed ? '購読中' : '未購読'}</strong></div>
        {onAndroidChrome && (
          <div style={{ marginTop: 8, opacity: .8 }}>
            ※ Android Chrome は OS/ブラウザの仕様上、Web ページから設定画面へ直接遷移できません。下の「手順を見る」から操作してください。
          </div>
        )}
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
        <button onClick={askPermission}>通知を許可する</button>
        <button onClick={reSubscribe} disabled={!userCode}>購読をやり直す</button>
        <button onClick={sendTest} disabled={!userCode}>テスト通知を送る</button>
        <details style={{ marginTop: 8 }}>
          <summary>手順を見る（Android Chrome）</summary>
          <ol style={{ margin: '8px 0 0 18px' }}>
            <li>右上の「︙」メニュー → <b>サイト設定</b> → <b>通知</b></li>
            <li><b>www.muverse.jp</b> を <b>許可</b> にする</li>
            <li>画面を戻って Muverse を再読み込み</li>
          </ol>
          <div style={{ opacity: .8, fontSize: 13 }}>※ 機種により表記が多少異なる場合があります。</div>
        </details>
      </div>
    </section>
  );
}
