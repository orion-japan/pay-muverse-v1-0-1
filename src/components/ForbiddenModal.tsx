'use client';

import React from 'react';
import './ForbiddenModal.css';

export default function ForbiddenModal() {
  return (
    <div className="forbidden-overlay">
      <div className="forbidden-modal">
        <h2>アクセスできません</h2>
        <p>このページは master プラン限定です。</p>
        <button onClick={() => (window.location.href = '/')}>戻る</button>
      </div>
    </div>
  );
}
