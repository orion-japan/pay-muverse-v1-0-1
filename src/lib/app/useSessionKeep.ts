// src/lib/app/useSessionKeep.ts
'use client';
import { useEffect } from 'react';

export function useSessionKeep() {
  useEffect(() => {
    const tick = async () => {
      try {
        await fetch('/api/auth/refresh', { credentials: 'include' });
      } catch {}
    };
    const onVis = () => {
      if (!document.hidden) tick();
    };

    window.addEventListener('visibilitychange', onVis);
    window.addEventListener('focus', tick);

    return () => {
      window.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('focus', tick);
    };
  }, []);
}
