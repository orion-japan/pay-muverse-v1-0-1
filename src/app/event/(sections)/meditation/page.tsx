// app/event/(sections)/meditation/page.tsx
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const runtime = 'nodejs';

import { Suspense } from 'react';
import MeditationClient from './MeditationClient';

export default function Page() {
  return (
    <Suspense fallback={<div style={{ padding: 16 }}>Loading...</div>}>
      <MeditationClient />
    </Suspense>
  );
}
