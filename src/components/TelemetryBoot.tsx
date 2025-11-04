'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { logClientEvent } from '@/utils/telemetry-client';
import { getAuth, onIdTokenChanged } from 'firebase/auth';

export default function TelemetryBoot() {
  const pathname = usePathname();

  // ページビュー（pathname 変化時）
  useEffect(() => {
    if (!pathname) return;
    logClientEvent({ kind: 'page', path: pathname });
  }, [pathname]);

  // online / offline
  useEffect(() => {
    const on = () => logClientEvent({ kind: 'event', path: 'net/online' });
    const off = () => logClientEvent({ kind: 'event', path: 'net/offline' });
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);

  // Auth 落ち（user が null になった）
  useEffect(() => {
    const auth = getAuth();
    const unsub = onIdTokenChanged(auth, (u) => {
      if (!u) {
        logClientEvent({
          kind: 'auth',
          path: 'auth/session-lost',
          note: 'token expired or signOut',
        });
      }
    });
    return () => unsub();
  }, []);

  return null;
}
