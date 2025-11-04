// src/components/ToastHost.tsx
'use client';
import React, { useEffect, useState } from 'react';
export default function ToastHost() {
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    const h = (e: any) => {
      setMsg(e.detail?.msg || '');
      setTimeout(() => setMsg(null), 3000);
    };
    window.addEventListener('toast', h as any);
    return () => window.removeEventListener('toast', h as any);
  }, []);
  if (!msg) return null;
  return <div className="toast warn">{msg}</div>;
}
