// src/components/OpenMuAiButton.tsx
'use client';

import { useState } from 'react';
import { auth } from '@/lib/firebase';

export default function OpenMuAiButton() {
  const [iframeUrl, setIframeUrl] = useState('');

  const openMuAi = async () => {
    try {
      const user = auth.currentUser;
      if (!user) {
        console.error('未ログインです');
        return;
      }

      // 1. 現在のidTokenを取得
      const idToken = await user.getIdToken(true);

      // 2. PAY側APIでcustomTokenを発行
      const res = await fetch('/api/firebase/custom-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken }),
      });

      if (!res.ok) {
        console.error('customToken発行失敗', await res.text());
        return;
      }

      const { customToken } = await res.json();

      // 3. MU側iframeのURLにcustomTokenを付与
      const url = `https://m.muverse.jp?customToken=${encodeURIComponent(customToken)}`;
      setIframeUrl(url);
      console.log('[PAY] iframe URL セット完了:', url);
    } catch (err) {
      console.error('[PAY] openMuAiエラー', err);
    }
  };

  return (
    <div>
      <button onClick={openMuAi} className="px-4 py-2 bg-blue-500 text-white rounded">
        MU-AIを開く
      </button>

      {iframeUrl && (
        <iframe id="muIframe" src={iframeUrl} className="w-full h-[600px] border mt-4"></iframe>
      )}
    </div>
  );
}
