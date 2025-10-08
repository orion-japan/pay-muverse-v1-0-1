// /app/mui/stage2/page.tsx
'use client';

import { useEffect, useState } from 'react';
import StageTwoPanel from '@/components/mui/StageTwoPanel';

/**
 * ユーザーの user_code を Supabase Auth から取得し、StageTwoPanel に渡す
 * 必ずログイン後である前提
 */

export default function Stage2Page() {
  const [userCode, setUserCode] = useState<string>('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/me');
        const j = await res.json();
        if (j?.user_code) setUserCode(j.user_code);
      } catch (e) {
        console.error('user_code fetch error', e);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading) return <div>Loading...</div>;
  return <StageTwoPanel user_code={userCode} />;
}