'use client';

import { PropsWithChildren } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';

/**
 * /self と /self/[code] の遷移でも layout を強制再マウントさせるラッパ。
 * key を pathname + search にするだけ。副作用なし。
 */
export default function SelfLayoutClient({ children }: PropsWithChildren) {
  const pathname = usePathname();
  const search = useSearchParams();
  const key = `${pathname}?${search?.toString() ?? ''}`;

  return (
    <div key={key} className="self-sizer">
      {children}
    </div>
  );
}
