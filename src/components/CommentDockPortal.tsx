'use client';
import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

type Props = { children: React.ReactNode };

export default function CommentDockPortal({ children }: Props) {
  const [host, setHost] = useState<HTMLElement | null>(null);

  useEffect(() => {
    const el = document.createElement('div');
    el.id = 'comment-dock-host';
    document.body.appendChild(el);
    setHost(el);
    return () => { document.body.removeChild(el); };
  }, []);

  if (!host) return null;
  return createPortal(children, host);
}
