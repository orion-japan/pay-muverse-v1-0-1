'use client';
import React from 'react';
import './page-title.css';

type Props = {
  title: string;
  subtitle?: string;
  right?: React.ReactNode; // 右側ボタンなど
};

export default function PageTitle({ title, subtitle, right }: Props) {
  return (
    <div className="mu-pagetitle">
      <div className="mu-pagetitle-left">
        <h1 className="mu-pagetitle-title">{title}</h1>
        {subtitle ? <div className="mu-pagetitle-sub">{subtitle}</div> : null}
      </div>
      <div className="mu-pagetitle-right">{right}</div>
    </div>
  );
}
