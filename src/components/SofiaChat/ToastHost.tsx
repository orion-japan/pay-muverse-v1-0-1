// src/components/SofiaChat/ToastHost.tsx
'use client';

import React, { useEffect, useState } from 'react';

type Toast = { id: string; kind: 'warn' | 'error'; msg: string };

export default function ToastHost() {
  const [toasts, setToasts] = useState<Toast[]>([]);

  useEffect(() => {
    const handler = (e: any) => {
      const t: Toast = {
        id: crypto.randomUUID(),
        kind: e.detail?.kind ?? 'warn',
        msg: e.detail?.msg ?? '',
      };
      setToasts((prev) => [...prev, t]);
      setTimeout(() => {
        setToasts((prev) => prev.filter((x) => x.id !== t.id));
      }, 3000);
    };
    window.addEventListener('toast', handler as any);
    return () => window.removeEventListener('toast', handler as any);
  }, []);

  if (!toasts.length) return null;

  return (
    <div
      style={{
        position: 'fixed',
        bottom: 20,
        right: 20,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        zIndex: 1000,
      }}
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          style={{
            padding: '10px 14px',
            borderRadius: 8,
            background: t.kind === 'warn' ? '#facc15' : '#ef4444',
            color: '#000',
            fontSize: 14,
            minWidth: 200,
            boxShadow: '0 2px 4px rgba(0,0,0,0.2)',
          }}
        >
          {t.msg}
        </div>
      ))}
    </div>
  );
}
