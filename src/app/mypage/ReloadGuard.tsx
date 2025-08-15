'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function ReloadGuard() {
  const router = useRouter();

  useEffect(() => {
    // Navigation Timing で「リロード」かどうかを正確に判定
    const nav = performance.getEntriesByType('navigation')[0] as
      | PerformanceNavigationTiming
      | undefined;

    if (nav?.type === 'reload') {
      // 必要ならここでログ出しもOK
      router.replace('/'); // ← HOMEへ退避
    }
  }, [router]);

  return null;
}
