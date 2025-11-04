// src/ui/iroschat/IrosChat.tsx
'use client';

import React from 'react';
import IrosChatShell from './IrosChatShell';
import IrosChatProvider from './IrosChatContext';

export default function IrosChat({ open }: { open?: string }) {
  return (
    <IrosChatProvider>
      <IrosChatShell open={open} />
    </IrosChatProvider>
  );
}
