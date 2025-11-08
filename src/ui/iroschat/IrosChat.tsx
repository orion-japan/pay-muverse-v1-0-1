'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import IrosChatProvider from './IrosChatContext';
import IrosChatShell from './IrosChatShell';

export default function IrosChat({ open = true }: { open?: boolean | string }) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();

  // URL から初期 open を読む（'menu' のときだけ一度開きたい）
  const urlOpen = sp.get('open');
  const urlCid = useMemo(() => sp.get('cid') ?? '', [sp]);

  // 1回だけ Sidebar に渡すためのステート
  const [openOnce, setOpenOnce] = useState<string | undefined>(() => {
    // props:boolean のときは 'menu' に正規化、string のときはそのまま
    const propOpen =
      typeof open === 'boolean' ? (open ? 'menu' : undefined) : (open as string | undefined);
    // URL優先（?open=menu があれば一度だけ開く）
    return urlOpen === 'menu' ? 'menu' : propOpen;
  });

  // ?open=menu を使った直後に URL から取り除く（次回リロードで勝手に開かない）
  useEffect(() => {
    if (urlOpen === 'menu') {
      const params = new URLSearchParams(sp.toString());
      params.delete('open');
      const q = params.toString();
      router.replace(q ? `${pathname}?${q}` : pathname, { scroll: false });
      // 子へは一度渡したので以後は undefined（=閉じる既定）
      setOpenOnce(undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlOpen, pathname]);

  // ルート or cid が変わったら自動で閉じる
  useEffect(() => {
    setOpenOnce(undefined);
  }, [pathname, urlCid]);

  return (
    <IrosChatProvider>
      {/* SidebarMobile は Shell 内で受け取る想定 */}
      <IrosChatShell open={openOnce} />
    </IrosChatProvider>
  );
}
