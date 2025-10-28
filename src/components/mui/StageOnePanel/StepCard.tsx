'use client';
import React from 'react';
import './StageOnePanel.css';

export default function StepCard({
  title,
  children,
  footer,
}: {
  title: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <div className="card">
      <div className="card__title">{title}</div>
      <div className="card__body">{children}</div>
      {footer && <div className="card__footer">{footer}</div>}
    </div>
  );
}
