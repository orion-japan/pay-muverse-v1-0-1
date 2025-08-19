'use client';

import { useEffect, useState } from 'react';
import { getAuth } from 'firebase/auth';
import ShipVisibilityBox from '@/components/Settings/ShipVisibilityBox';

export default function SettingsPage() {
  const [plan, setPlan] = useState<'free'|'regular'|'premium'|'master'|'admin'>('free');

  useEffect(() => {
    (async () => {
      const auth = getAuth();
      const user = auth.currentUser;
      if (!user) return;
      const token = await user.getIdToken(true);
      // 課金プランを取得（/api/account-status から click_type を読む）
      const res = await fetch('/api/account-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const j = await res.json();
        const ct = j?.click_type as string;
        setPlan(
          ct === 'regular' ? 'regular' :
          ct === 'premium' ? 'premium' :
          ct === 'master' ? 'master' :
          ct === 'admin' ? 'admin' : 'free'
        );
      }
    })();
  }, []);

  return (
    <div className="settings-page">
      <h2>設定</h2>
      <ShipVisibilityBox planStatus={plan} />
    </div>
  );
}
