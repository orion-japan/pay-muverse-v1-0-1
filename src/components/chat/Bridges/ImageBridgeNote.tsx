// src/components/chat/Bridges/ImageBridgeNote.tsx
// Mu 画像生成ブリッジ用の定型句表示コンポーネント

'use client';

import React, { useMemo } from 'react';
import { MU_BRIDGE_TEXT } from '@/lib/mu/config';
import { buildImageBridgeText } from '@/lib/qcode/bridgeImage';

export type ImageBridgeNoteProps = {
  phase?: 'suggest' | 'confirmStyle' | 'done';
  previewLine?: string;
  onSend: (text: string) => void;
};

/**
 * ユーザーに画像生成の流れを案内する定型コンポーネント
 * - phase に応じてメッセージ切り替え
 * - OK ボタンなどで onSend に渡す
 */
export default function ImageBridgeNote({
  phase = 'suggest',
  previewLine,
  onSend,
}: ImageBridgeNoteProps) {
  const text = useMemo(
    () =>
      phase === 'done'
        ? buildImageBridgeText({ phase, previewLine })
        : buildImageBridgeText({ phase }),
    [phase, previewLine],
  );

  return (
    <div style={styles.note}>
      <div style={styles.text}>{text}</div>
      {phase === 'suggest' && (
        <div style={styles.actions}>
          <button style={styles.btn} onClick={() => onSend(text)}>
            OK
          </button>
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  note: {
    padding: '10px 12px',
    borderRadius: 10,
    border: '1px solid rgba(255,255,255,0.15)',
    background: 'rgba(255,255,255,0.04)',
    fontSize: 13,
    lineHeight: 1.6,
    color: '#e8ecff',
    marginTop: 8,
  },
  text: { marginBottom: 6, whiteSpace: 'pre-wrap' },
  actions: { display: 'flex', justifyContent: 'flex-end' },
  btn: {
    padding: '6px 12px',
    borderRadius: 6,
    border: '1px solid rgba(255,255,255,0.25)',
    background: 'rgba(93,139,255,0.18)',
    color: '#fff',
    fontSize: 12,
    cursor: 'pointer',
  },
};
