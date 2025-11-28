// src/ui/iroschat/IrosChat.tsx
'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
// 🔽 ここを削除：IrosChatProvider は page.tsx 側で包む
// import { IrosChatProvider } from './IrosChatContext';
import IrosChatShell from './IrosChatShell';

export default function IrosChat({ open = true }: { open?: boolean | string }) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();

  const urlOpen = sp.get('open');
  const urlCid = useMemo(() => sp.get('cid') ?? '', [sp]);

  const [openOnce, setOpenOnce] = useState<string | undefined>(() => {
    const propOpen =
      typeof open === 'boolean' ? (open ? 'menu' : undefined) : (open as string | undefined);
    return urlOpen === 'menu' ? 'menu' : propOpen;
  });

  useEffect(() => {
    if (urlOpen === 'menu') {
      const params = new URLSearchParams(sp.toString());
      params.delete('open');
      const q = params.toString();
      router.replace(q ? `${pathname}?${q}` : pathname, { scroll: false });
      setOpenOnce(undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlOpen, pathname]);

  useEffect(() => {
    setOpenOnce(undefined);
  }, [pathname, urlCid]);

  return (
    // 🔽 Provider なしでそのまま Shell を返す
    <IrosChatShell open={openOnce} />
  );
}
