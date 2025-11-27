// src/app/iros-ai/settings/page.tsx
'use client';

import React from 'react';
import Link from 'next/link';

export default function IrosAiSettingsPage() {
  return (
    <div style={{ padding: '24px' }}>
      {/* 戻るボタン */}
      <Link href="/iros-ai">
        <button
          type="button"
          style={{
            padding: '6px 16px',
            borderRadius: 999,
            border: '1px solid rgba(0,0,0,0.2)',
            background: '#fff',
            cursor: 'pointer',
            fontSize: '0.85rem',
            marginBottom: '20px',
          }}
        >
          ← 戻る
        </button>
      </Link>

      <h1 style={{ fontSize: '1.2rem', marginBottom: '12px' }}>Iros 設定</h1>

      <p style={{ opacity: 0.7 }}>
        ※この設定画面は準備中です。
        <br />
        今後、モードや通知、ログなどの設定を管理できるようになります。
      </p>
    </div>
  );
}
