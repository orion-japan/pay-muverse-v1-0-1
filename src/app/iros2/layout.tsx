'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/context/AuthContext';

type UserRole = 'free' | 'member' | 'pro' | 'master' | 'admin' | string;

export default function IrosLayout({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const [role, setRole] = useState<UserRole | null>(null);
  const [allowed, setAllowed] = useState<boolean | null>(null); // ← 判定結果を状態に持つ
  const router = useRouter();

  // click_type を API から取得
  useEffect(() => {
    if (loading) return;
    if (!user) {
      setAllowed(false);
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const idToken = await user.getIdToken(true);
        const res = await fetch('/api/get-user-info', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
          body: JSON.stringify({ idToken }),
          cache: 'no-store',
        });
        const j = await res.json().catch(() => ({}));
        const ct: UserRole | null = j?.user?.click_type ?? j?.click_type ?? null;
        if (!cancelled) {
          setRole(ct ?? 'free');
          setAllowed(ct === 'master' || ct === 'admin');
        }
      } catch {
        if (!cancelled) {
          setRole('free');
          setAllowed(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [loading, user]);

  // 権限が NG のときだけ遷移
  useEffect(() => {
    if (allowed === false) {
      router.replace('/');
    }
  }, [allowed, router]);

  // ローディング or 判定中は何も描画しない
  if (loading || allowed === null) return null;

  // NG のときは何も描画しない（リダイレクト済み）
  if (allowed === false) return null;

  // master/admin のみ children を表示
  return <div style={{ display: 'contents' }}>{children}</div>;
}
