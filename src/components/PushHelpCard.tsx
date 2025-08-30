'use client';
import { useEffect, useMemo, useState } from 'react';
import { registerPush } from '@/utils/push';
import { useAuth } from '@/context/AuthContext';
import './PushHelpCard.css';

function isAndroidChrome() {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent.toLowerCase();
  return ua.includes('android') && ua.includes('chrome') && !ua.includes('edg');
}
function isIPhoneSafari() {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent.toLowerCase();
  // iPhone / iPad / iPod かつ Safari（Chrome for iOS は "CriOS"）
  return /iphone|ipad|ipod/.test(ua) && ua.includes('safari') && !ua.includes('crios');
}

export default function PushHelpCard() {
  const { userCode } = useAuth();
  const [perm, setPerm] = useState<NotificationPermission | 'unsupported'>('default');
  const [subscribed, setSubscribed] = useState<boolean | null>(null);

  const onAndroidChrome = useMemo(isAndroidChrome, []);
  const oniPhoneSafari = useMemo(isIPhoneSafari, []);

  useEffect(() => {
    if (typeof Notification === 'undefined') setPerm('unsupported');
    else setPerm(Notification.permission);

    (async () => {
      if (!('serviceWorker' in navigator)) { setSubscribed(null); return; }
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
    <section className="push-card">
      <h3 className="push-title">プッシュ通知の受信設定</h3>

      <div className="push-status">
        <div>ブラウザ権限：<strong>{perm === 'unsupported' ? '未対応' : perm}</strong></div>
        <div>購読状態：<strong>{subscribed === null ? '不明' : subscribed ? '購読中' : '未購読'}</strong></div>
        <div className="hint">※ ボタンはログイン中のあなた（user_code: {userCode ?? '—'}）への通知を再登録／送信します。</div>
      </div>

      <div className="push-buttons">
        <button className="push-btn" onClick={askPermission}>通知を許可する</button>
        <button className="push-btn" onClick={reSubscribe} disabled={!userCode}>購読をやり直す</button>
        <button className="push-btn" onClick={sendTest} disabled={!userCode}>テスト通知を送る</button>
      </div>

      {/* どの端末でも両方表示。自分の端末にはバッジを付ける */}
      <details className="push-help" open={onAndroidChrome}>
        <summary>
          手順を見る（Android Chrome）
          {onAndroidChrome && <span className="badge">あなたの端末</span>}
        </summary>
        <ol>
          <li>右上の「︙」メニュー → <b>サイト設定</b> → <b>通知</b></li>
          <li><b>www.muverse.jp</b> を <b>許可</b> にする</li>
          <li>画面を戻って Muverse を再読み込み</li>
        </ol>
      </details>

      <details className="push-help" open={oniPhoneSafari}>
        <summary>
          手順を見る（iPhone Safari）
          {oniPhoneSafari && <span className="badge">あなたの端末</span>}
        </summary>
        <ol>
          <li>iPhoneの <b>設定アプリ</b> を開く</li>
          <li><b>通知</b> → 下へスクロールして <b>Safari</b> を選択</li>
          <li><b>通知を許可</b> をオンにする</li>
          <li>Safariで <b>www.muverse.jp</b> を開き、サイトからの通知を許可</li>
        </ol>
        <div className="hint">※ iOS 16.4 以降が必要です。</div>
      </details>
    </section>
  );
}
