'use client';

import { useEffect, useRef } from 'react';
// 共有のルーム名を1箇所で管理するのがおすすめ
// 例: src/lib/live-room.ts に export const DEFAULT_LIVE_ROOM = 'KyomeikaiLiveRoom';
import { DEFAULT_LIVE_ROOM } from '@/lib/live-room';
import '@/app/kyomeikai/kyomeikai.css';

export default function LivePage() {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let api: any | null = null;

    const loadScript = () =>
      new Promise<void>((resolve, reject) => {
        if ((window as any).JitsiMeetExternalAPI) return resolve();
        if (document.querySelector('script[src="https://meet.jit.si/external_api.js"]'))
          return resolve(); // 既に読み込み済み
        const s = document.createElement('script');
        s.src = 'https://meet.jit.si/external_api.js';
        s.async = true;
        s.onload = () => resolve();
        s.onerror = (e) => reject(e);
        document.body.appendChild(s);
      });

    (async () => {
      await loadScript();
      if (!containerRef.current || !(window as any).JitsiMeetExternalAPI) return;

      api = new (window as any).JitsiMeetExternalAPI('meet.jit.si', {
        parentNode: containerRef.current,
        roomName: DEFAULT_LIVE_ROOM, // ← ホストと同じ
        width: '100%',
        height: 600,
        userInfo: { displayName: 'LIVE視聴者' },
        configOverwrite: {
          prejoinPageEnabled: false,
          disableInviteFunctions: true,
          startWithAudioMuted: true,
          startWithVideoMuted: true,
        },
        interfaceConfigOverwrite: {
          TOOLBAR_BUTTONS: ['microphone', 'camera', 'chat', 'tileview', 'hangup'],
          SHOW_JITSI_WATERMARK: false,
          SHOW_BRAND_WATERMARK: false,
        },
      });

      // 念のためミュート/ビデオOFF（視聴専用想定）
      try { api.executeCommand('toggleAudio'); } catch {}
      try { api.executeCommand('toggleVideo'); } catch {}
    })();

    return () => { try { api?.dispose(); } catch {} };
  }, []);

  return (
    <div style={{ padding: 20 }}>
      <h1 style={{ fontSize: '1.5rem', marginBottom: 10 }}>🌐 共鳴会 LIVE</h1>
      <div ref={containerRef} style={{ border: '1px solid #ccc', borderRadius: 8 }} />
      <p style={{ marginTop: 10, color: '#666' }}>
        ※ ホストが同じルーム名（{DEFAULT_LIVE_ROOM}）で配信している場合に映像が表示されます。
      </p>
    </div>
  );
}
