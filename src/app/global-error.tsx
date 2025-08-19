'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const router = useRouter();

  useEffect(() => {
    // 画面白化を防ぎ、即ホームへ退避
    const t = setTimeout(() => router.replace('/'), 0);
    return () => clearTimeout(t);
  }, [router]);

  // ユーザーには何も見せない（点滅防止のため空）
  return null;
}
