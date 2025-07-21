import { Suspense } from 'react';
import MyPageEntry from './MyPageEntry';

export default function MyPage() {
  return (
    <Suspense fallback={<p>🔄 ロード中...</p>}>
      <MyPageEntry />
    </Suspense>
  );
}
