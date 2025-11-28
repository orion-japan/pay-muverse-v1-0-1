// src/app/iros-ai/page.tsx
import React, { Suspense } from 'react';
import IrosAiLayout from '@/ui/iroschat/IrosAiLayout';
import IrosChat from '@/ui/iroschat/IrosChat';
import { IrosChatProvider } from '@/ui/iroschat/IrosChatContext';

// 静的プリレンダではなく、常に動的にする（/iros と同じ）
export const dynamic = 'force-dynamic';

export default function IrosAiPage() {
  return (
    <IrosChatProvider>
      <IrosAiLayout>
        {/* useSearchParams() を使う IrosChat ツリーを Suspense で包む */}
        <Suspense fallback={null}>
          <IrosChat />
        </Suspense>
      </IrosAiLayout>
    </IrosChatProvider>
  );
}
