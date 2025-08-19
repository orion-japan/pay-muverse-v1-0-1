'use client';

import { useEffect, useRef, useState } from 'react';
import { useAuth } from '@/context/AuthContext';

declare global {
  interface Window {
    JitsiMeetExternalAPI?: any;
  }
}

export default function LivePage() {
  const { user } = useAuth();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const apiRef = useRef<any>(null);

  // 配信ステータス
  const [isLive, setIsLive] = useState<boolean | null>(null);
  const [roomFromStatus, setRoomFromStatus] = useState<string | undefined>(undefined);

  useEffect(() => {
    let mounted = true;

    // 外部APIスクリプトを読み込み（多重ロード防止）
    const loadScript = () =>
      new Promise<void>((resolve, reject) => {
        if (window.JitsiMeetExternalAPI) return resolve();
        const s = document.createElement('script');
        s.src = 'https://meet.jit.si/external_api.js';
        s.async = true;
        s.onload = () => resolve();
        s.onerror = (e) => reject(e);
        document.body.appendChild(s);
      });

    (async () => {
      try {
        // 1) 配信状況を確認
        const r = await fetch('/api/kyomeikai/live/status', { cache: 'no-store' });
        const j = await r.json().catch(() => null);
        if (!mounted) return;
        const live = !!j?.is_live;
        setIsLive(live);
        setRoomFromStatus(j?.room);

        // 非配信ならJitsi起動せず終了
        if (!live) return;

        // 2) Jitsi埋め込み
        await loadScript();
        if (!mounted || !containerRef.current || !window.JitsiMeetExternalAPI) return;

        // 既存インスタンス破棄
        if (apiRef.current) {
          try { apiRef.current.dispose(); } catch {}
          apiRef.current = null;
        }

        const today = new Date().toISOString().split('T')[0];
        const roomName = (j?.room && String(j.room)) || `kyomeikai-live-${today}`;

        // 表示名のフォールバック
        const displayName =
          user?.displayName ||
          user?.email?.split('@')[0] ||
          'Guest';

        apiRef.current = new window.JitsiMeetExternalAPI('meet.jit.si', {
          parentNode: containerRef.current,
          roomName,
          width: '100%',
          height: '100%',
          userInfo: { displayName },
          configOverwrite: {
            prejoinConfig: { enabled: false },
            disableDeepLinking: true,
            mobileAppPromo: false,
            startWithAudioMuted: true,
            startWithVideoMuted: true,
          },
          interfaceConfigOverwrite: {
            MOBILE_APP_PROMO: false,
            TOOLBAR_BUTTONS: [
              'microphone', 'camera', 'desktop', 'tileview',
              'chat', 'raisehand', 'settings', 'hangup'
            ],
          },
        });

        apiRef.current.on('readyToClose', () => {
          try { apiRef.current?.dispose(); } catch {}
          apiRef.current = null;
        });
      } catch (e) {
        console.error('Jitsi init failed:', e);
        setIsLive(false);
      }
    })();

    return () => {
      mounted = false;
      try { apiRef.current?.dispose(); } catch {}
      apiRef.current = null;
    };
  }, [user]); // ← userCodeは依存から削除

  return (
    <div className="mu-page mu-main">
      <header className="km-header" style={{ padding: '12px 16px' }}>
        <h1 className="km-title" style={{ fontSize: '18px' }}>共鳴会 LIVE</h1>
      </header>

      {/* 埋め込み領域 */}
      <div
        ref={containerRef}
        style={{
          width: '100%',
          height: 'calc(100vh - 72px)',
          background: '#000',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#fff',
        }}
      >
        {isLive === false && (
          <div style={{ textAlign: 'center', padding: '12px', opacity: .9 }}>
            <div style={{ fontSize: '16px', marginBottom: '6px' }}>現在LIVE配信は行われていません。</div>
            {roomFromStatus ? <div>次回ルーム: {roomFromStatus}</div> : null}
          </div>
        )}
        {isLive === null && <div style={{ opacity: .8 }}>配信状況を確認中…</div>}
        {/* isLive === true のときJitsiがこの領域に描画 */}
      </div>
    </div>
  );
}
