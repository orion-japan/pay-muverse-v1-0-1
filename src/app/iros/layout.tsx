// src/app/iros/page.tsx
import { Suspense } from 'react';
import IrosChat from '@/ui/iroschat/IrosChat';

// CSR前提にして静的化を抑止（念のため）
export const dynamic = 'force-dynamic';

export default function Page() {
  return (
    <Suspense fallback={<div style={{padding:16}}>Loading…</div>}>
      <IrosChat />
    </Suspense>
  );
}

