'use client';
import { useState } from 'react';
import AlbumModal from '@/components/AlbumModal';

export default function AlbumButtonAndModal() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        style={{ padding: '10px 14px', borderRadius: 10, border: '1px solid #ccc', background: '#fff', cursor: 'pointer' }}
      >アルバムを開く</button>

      <AlbumModal
        open={open}
        title="アルバム"
        onClose={() => setOpen(false)}
        onSubmit={() => { /* 保存処理 */ setOpen(false); }}
      >
        {/* ここに画像グリッドやプレビューUIを配置 */}
        <div style={{ height: 280, border: '1px dashed #ddd', borderRadius: 8, display: 'grid', placeItems: 'center' }}>
          プレビュー or 画像一覧
        </div>
      </AlbumModal>
    </>
  );
}
