// src/app/iros-ai/page.tsx
import React, { Suspense } from 'react';
import IrosAiLayout from '@/ui/iroschat/IrosAiLayout';
import IrosChat from '@/ui/iroschat/IrosChat';

// 静的プリレンダではなく、常に動的にする（/iros と同じ）
export const dynamic = 'force-dynamic';

export default function IrosAiPage() {
  return (
    <IrosAiLayout>
      {/* useSearchParams() を使う IrosChat ツリーを Suspense で包む */}
      <Suspense fallback={null}>
        <IrosChat />
      </Suspense>
    </IrosAiLayout>
  );
}
