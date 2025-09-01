// src/components/AlbumButtonAndModal.tsx
'use client';

import { useState } from 'react';
import AlbumModal from '@/components/AlbumModal';

export default function AlbumButtonAndModal() {
  const [open, setOpen] = useState(false);

  return (
    <div style={{ display: 'inline-block' }}>
      <button
        type="button"
        onClick={() => setOpen(true)}
        style={{
          padding: '10px 16px',
          borderRadius: 10,
          border: '1px solid #e5e7eb',
          background: '#fff',
          cursor: 'pointer',
        }}
      >
        アルバムから追加
      </button>

      <AlbumModal
        open={open}
        onClose={() => setOpen(false)}
        onConfirm={() => {
          // 選択結果の処理を実装してください
          setOpen(false);
        }}
      >
        {/* ここに AlbumPicker などを後で挿し込めます */}
        <p style={{ margin: 0 }}>アルバム一覧をここに配置（後で実装）。</p>
      </AlbumModal>
    </div>
  );
}
