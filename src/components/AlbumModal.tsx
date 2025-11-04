// src/components/AlbumModal.tsx
'use client';

import React, { useEffect } from 'react';

type AlbumModalProps = {
  open: boolean;
  title?: string;
  onClose: () => void;
  onConfirm?: () => void;
  children?: React.ReactNode; // 必要に応じて中身を差し替え
};

export default function AlbumModal({
  open,
  title = 'アルバムから選択',
  onClose,
  onConfirm,
  children,
}: AlbumModalProps) {
  // ESCで閉じる
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div style={styles.backdrop} aria-modal aria-hidden={false} role="dialog">
      <div style={styles.modal}>
        <div style={styles.header}>
          <h3 style={styles.title}>{title}</h3>
          <button style={styles.close} onClick={onClose} aria-label="close">
            ×
          </button>
        </div>

        <div style={styles.body}>
          {/* ここにピッカーや一覧を入れてください */}
          {children ?? <p style={{ margin: 0 }}>ここにアルバムの内容を実装してください。</p>}
        </div>

        <div style={styles.footer}>
          <button style={styles.secondary} onClick={onClose}>
            キャンセル
          </button>
          {onConfirm && (
            <button style={styles.primary} onClick={onConfirm}>
              決定
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  backdrop: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,.45)',
    display: 'grid',
    placeItems: 'center',
    zIndex: 1000,
  },
  modal: {
    width: 'min(720px, 92vw)',
    background: '#fff',
    borderRadius: 12,
    boxShadow: '0 10px 30px rgba(0,0,0,.18)',
    overflow: 'hidden',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    padding: '12px 16px',
    borderBottom: '1px solid #e5e7eb',
  },
  title: {
    fontSize: 16,
    fontWeight: 600,
    margin: 0,
    flex: 1,
  },
  close: {
    border: 'none',
    background: 'transparent',
    fontSize: 20,
    lineHeight: 1,
    cursor: 'pointer',
  },
  body: {
    padding: 16,
    maxHeight: '60vh',
    overflow: 'auto',
  },
  footer: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: 8,
    padding: 12,
    borderTop: '1px solid #e5e7eb',
  },
  primary: {
    padding: '10px 16px',
    borderRadius: 8,
    border: '1px solid #2563eb',
    background: '#2563eb',
    color: '#fff',
    cursor: 'pointer',
  },
  secondary: {
    padding: '10px 16px',
    borderRadius: 8,
    border: '1px solid #e5e7eb',
    background: '#fff',
    color: '#111827',
    cursor: 'pointer',
  },
};
