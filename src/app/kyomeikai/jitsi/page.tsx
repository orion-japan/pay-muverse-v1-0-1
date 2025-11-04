import { Suspense } from 'react';
import JitsiClient from './JitsiClient';

// SSGさせない & キャッシュしない
export const dynamic = 'force-dynamic';
export const fetchCache = 'default-no-store';
// ※ revalidate は一切 export しない（衝突回避）

export default function Page() {
  return (
    <Suspense
      fallback={
        <div
          style={{
            width: '100%',
            height: '100dvh',
            display: 'grid',
            placeItems: 'center',
            color: '#888',
            background: '#000',
          }}
        >
          読み込み中…
        </div>
      }
    >
      <JitsiClient />
    </Suspense>
  );
}
