import { Suspense } from 'react';
import KyomeikaiClient from './KyomeikaiClient';

export const dynamic = 'force-dynamic'; // 任意：SSR前提なら
export const revalidate = 0; // 任意：完全動的に
export const runtime = 'nodejs'; // 任意：サーバーで確実に

export default function KyomeikaiPage() {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <KyomeikaiClient />
    </Suspense>
  );
}
