// src/app/mtalk/[threadId]/page.tsx
'use client';

import { useEffect } from 'react';
import { useSearchParams, usePathname, useRouter, useParams } from 'next/navigation';
import SofiaChat from '@/components/SofiaChat/SofiaChat';

export default function MTalkChatPage() {
  const sp = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const { threadId } = useParams<{ threadId: string }>();

  // URLに cid が無ければ、パスの threadId を cid として付与（同一会話IDを強制引き継ぎ）
  useEffect(() => {
    if (!threadId) return;
    if (!sp.get('cid')) {
      const q = new URLSearchParams(Array.from(sp.entries()));
      q.set('cid', threadId);
      router.replace(`${pathname}?${q.toString()}`, { scroll: false });
    }
  }, [threadId, sp, pathname, router]);

  // agent は mu / iros / mirra（既定は mirra）
  const agentParam = (sp.get('agent') || 'mirra').toLowerCase();
  const agent = agentParam === 'mu' || agentParam === 'iros' || agentParam === 'mirra' ? agentParam : 'mirra';

  return <SofiaChat agent={agent} />;
}
