'use client';

import { useEffect, useState } from 'react';
import { getAuth } from 'firebase/auth';
import ShipVisibilityBox from '@/components/Settings/ShipVisibilityBox';
import NotificationSettingsBox from './NotificationSettingsBox';

type Plan = 'free'|'regular'|'premium'|'master'|'admin';

export default function SettingsPage() {
  const [plan, setPlan] = useState<Plan>('free');

  useEffect(() => {
    let mounted = true;
    const ac = new AbortController();

    (async () => {
      const auth = getAuth();
      const user = auth.currentUser;
      if (!user) return;
      const token = await user.getIdToken(true);

      const res = await fetch('/api/account-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        signal: ac.signal,
      }).catch(() => null);

      if (!res?.ok) return;
      const j = await res.json();
      const ct = j?.click_type as string | undefined;
      if (!mounted) return;
      setPlan(
        ct === 'regular' ? 'regular' :
        ct === 'premium' ? 'premium' :
        ct === 'master' ? 'master' :
        ct === 'admin' ? 'admin' : 'free'
      );
    })();

    return () => { mounted = false; ac.abort(); };
  }, []);

  return (
    <div style={{ padding: 12, overflowY: 'auto' }}>
      <h2 style={{ marginBottom: 12 }}>設定</h2>

      <div style={{ marginBottom: 16 }}>
        <ShipVisibilityBox planStatus={plan} />
      </div>

      <div style={{ marginBottom: 24 }}>
        <NotificationSettingsBox />
      </div>
    </div>
  );
}
