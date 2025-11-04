'use client';

import { ReactNode } from 'react';
import './app-modal.css';

type Props = {
  open: boolean;
  title?: string;
  children?: ReactNode;
  onClose: () => void;
  primaryText?: string;
  onPrimary?: () => void;
};

export default function AppModal({
  open,
  title,
  children,
  onClose,
  primaryText = 'OK',
  onPrimary,
}: Props) {
  if (!open) return null;
  return (
    <div className="mu-modal__overlay" role="dialog" aria-modal="true">
      <div className="mu-modal__box">
        {title ? <div className="mu-modal__title">{title}</div> : null}
        <div className="mu-modal__body">{children}</div>
        <div className="mu-modal__actions">
          <button className="mu-btn ghost" onClick={onClose}>
            閉じる
          </button>
          <button
            className="mu-btn primary"
            onClick={() => {
              onPrimary?.();
              onClose();
            }}
          >
            {primaryText}
          </button>
        </div>
      </div>
    </div>
  );
}
