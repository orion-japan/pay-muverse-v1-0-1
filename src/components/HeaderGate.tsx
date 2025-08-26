'use client';

import { usePathname } from 'next/navigation';
import Header from '@/components/Header';

type Props = { onLoginClick: () => void };

export default function HeaderGate(props: Props) {
  const pathname = (usePathname() || '').toLowerCase();

  // /iros 配下ではヘッダー非表示
  if (pathname.startsWith('/iros')) return null;

  // それ以外は通常の Header をそのまま表示
  return <Header {...props} />;
}
