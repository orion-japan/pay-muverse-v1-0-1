// src/components/modals/GenericModal.tsx
'use client';

import React, { ReactNode } from 'react';
import '../../styles/modals.css';

type GenericModalProps = {
  isOpen: boolean;
  title: React.ReactNode;   // ← ここを string から React.ReactNode にする
  onCancel: () => void;
  onConfirm: () => void;
  confirmLabel?: string;
  cancelLabel?: string;
  children?: React.ReactNode;
};


export default function GenericModal({
  isOpen,
  title,
  children,
  onCancel,
  onConfirm,
  confirmLabel = 'OK',
  cancelLabel = 'キャンセル',
}: GenericModalProps) {
  if (!isOpen) return null;

  return (
    <div className="modal-overlay">
      <div className="modal-box">
        {title && <h2 className="modal-title">{title}</h2>}

        <div className="modal-content">{children}</div>

        <div className="modal-buttons">
          {onCancel && (
            <button className="btn-cancel" onClick={onCancel}>
              {cancelLabel}
            </button>
          )}
          {onConfirm && (
            <button className="btn-confirm" onClick={onConfirm}>
              {confirmLabel}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
