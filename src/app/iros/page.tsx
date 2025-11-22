// src/app/iros/page.tsx
import React, { Suspense } from 'react';
import IrosLayout from '@/ui/iroschat/IrosLayout';
import IrosChat from '@/ui/iroschat/IrosChat';

// 静的プリレンダではなく、常に動的にする（安全策）
export const dynamic = 'force-dynamic';

export default function Page() {
  return (
    <IrosLayout>
      {/* useSearchParams() を使う IrosChat ツリーを Suspense で包む */}
      <Suspense fallback={null}>
        <IrosChat />
      </Suspense>
    </IrosLayout>
  );
}
