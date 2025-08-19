'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/context/AuthContext';

export default function AuthGate() {
  const router = useRouter();
  const { user, loading } = useAuth();

  useEffect(() => {
    if (loading) return;          // 認証確定まで待つ
    if (!user) router.replace('/'); // 未ログインならホームへ
  }, [loading, user, router]);

  return null; // 監視だけ
}
