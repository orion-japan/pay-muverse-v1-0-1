// src/app/kyomeikai/jitsi/JitsiClient.tsx
'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';

declare global {
  interface Window {
    JitsiMeetExternalAPI?: any;
  }
}

/** Jitsi external_api を読み込み */
function loadJitsiExternalAPI(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (typeof window !== 'undefined' && window.JitsiMeetExternalAPI) {
      resolve();
      return;
    }
    const existed = document.querySelector<HTMLScriptElement>('script[data-jitsi-ext]');
    if (existed) {
      existed.addEventListener('load', () => resolve());
      existed.addEventListener('error', () => reject(new Error('jitsi external_api load error')));
      return;
    }
    const s = document.createElement('script');
    s.src = 'https://meet.jit.si/external_api.js';
    s.async = true;
    s.defer = true;
    s.dataset.jitsiExt = '1';
    s.addEventListener('load', () => resolve());
    s.addEventListener('error', () => reject(new Error('jitsi external_api load error')));
    document.head.appendChild(s);
  });
}

/** 日付ベースでルーム名を生成（例: kyomeikai-20250809） */
function generateRoomNameByDate() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `kyomeikai-${y}${m}${day}`;
}

export default function JitsiClient() {
  const params = useSearchParams();
  const nameFromQuery = useMemo(() => params.get('name') || 'Guest', [params]);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const apiRef = useRef<any>(null);

  const [room] = useState<string>(generateRoomNameByDate()); // 日付固定
  const [error, setError] = useState<string | null>(null);
  const retryTimerRef = useRef<any>(null);

  useEffect(() => {
    let disposed = false;

    (async () => {
      try {
        await loadJitsiExternalAPI();
        if (disposed) return;

        const api = new window.JitsiMeetExternalAPI!('meet.jit.si', {
          roomName: room,
          parentNode: containerRef.current!,
          width: '100%',
          height: '100%',
          configOverwrite: {
            prejoinPageEnabled: false,
            disableDeepLinking: true,
            defaultLanguage: 'ja',
          },
          interfaceConfigOverwrite: {
            MOBILE_APP_PROMO: false,
            SHOW_JITSI_WATERMARK: false,
          },
          userInfo: { displayName: nameFromQuery },
        });
        apiRef.current = api;

        api.addListener('conferenceFailed', (e: any) => {
          const reason = String(e?.error || e || '');
          if (reason.includes('membersOnly')) {
            setError(
              'ミーティングはまだ開始されていません。ホストの入室をお待ちください…（自動で再接続します）',
            );
            if (!retryTimerRef.current) {
              retryTimerRef.current = setInterval(() => {
                try {
                  apiRef.current?.dispose?.();
                } catch {}
                window.location.reload();
              }, 10_000);
            }
          } else {
            setError('接続に失敗しました。');
          }
        });
      } catch (e: any) {
        if (!disposed) setError(e?.message ?? '会議の読み込みに失敗しました');
      }
    })();

    return () => {
      disposed = true;
      if (retryTimerRef.current) {
        clearInterval(retryTimerRef.current);
        retryTimerRef.current = null;
      }
      try {
        apiRef.current?.dispose?.();
      } catch {}
    };
  }, [room, nameFromQuery]);

  return (
    <div style={{ width: '100%', height: '100dvh', background: '#000', position: 'relative' }}>
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
      {error && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'grid',
            placeItems: 'center',
            color: '#fff',
            background: 'rgba(0,0,0,0.6)',
            padding: 16,
            textAlign: 'center',
          }}
        >
          {error}
          <div style={{ marginTop: 8, fontSize: 12, opacity: 0.7 }}>room: {room}</div>
        </div>
      )}
    </div>
  );
}
