'use client';
import { useAuth } from '@/context/AuthContext';
import { useEffect, useState } from 'react';

const FOOTER_H = 60;

type Props = {
  baseUrl: string; // iframe先のURL（クエリなし）
};

export default function IframePage({ baseUrl }: Props) {
  const { userCode, loading } = useAuth();
  const [url, setUrl] = useState('');

  useEffect(() => {
    if (!loading && userCode) {
      setUrl(`${baseUrl}?user=${encodeURIComponent(userCode)}&embed=1`);
    }
  }, [loading, userCode, baseUrl]);

  if (loading) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100dvh',
          background: '#fff',
        }}
      >
        <p style={{ color: '#666', fontSize: 16 }}>読み込み中...</p>
      </div>
    );
  }

  if (!userCode) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100dvh',
          background: '#fff',
        }}
      >
        <p style={{ color: '#666', fontSize: 16 }}>🔒 ログインが必要です。</p>
      </div>
    );
  }

  return (
    <div style={{ width: '100%' }}>
      {url && (
        <iframe
          src={url}
          style={{
            display: 'block',
            width: '100%',
            height: `calc(100dvh - ${FOOTER_H}px)`,
            border: 'none',
            background: 'transparent',
          }}
          allow="clipboard-write; microphone *; camera *"
        />
      )}
    </div>
  );
}
