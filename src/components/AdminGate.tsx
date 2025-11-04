// src/components/AdminGate.tsx
'use client';
import { useEffect, useState } from 'react';
import { useAuth } from '@/context/AuthContext';
import { fetchWithIdToken } from '@/lib/fetchWithIdToken';

export default function AdminGate({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const [ok, setOk] = useState<boolean | null>(null);

  useEffect(() => {
    let gone = false;
    (async () => {
      if (!user) {
        setOk(false);
        return;
      }
      try {
        const r = await fetchWithIdToken('/api/get-user-info');
        const j = await r.json();
        const role = String(j.role ?? j.user_role ?? '').toLowerCase();
        const plan = String(j.plan ?? j.plan_status ?? '').toLowerCase();
        const isAdmin =
          j.is_admin === true ||
          j.is_master === true ||
          role === 'admin' ||
          role === 'master' ||
          plan === 'admin' ||
          plan === 'master';
        if (!gone) setOk(isAdmin);
      } catch {
        if (!gone) setOk(false);
      }
    })();
    return () => {
      gone = true;
    };
  }, [user]);

  if (ok === null) return <div style={{ padding: 16 }}>Checking permission…</div>;
  if (!ok) return <div style={{ padding: 16 }}>403 — 管理権限が必要です。</div>;
  return <>{children}</>;
}
