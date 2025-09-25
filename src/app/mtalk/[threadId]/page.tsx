// src/app/mtalk/[threadId]/page.tsx
'use client';

import { useEffect, useRef } from 'react';
import { useSearchParams, usePathname, useRouter, useParams } from 'next/navigation';
import SofiaChat from '@/components/SofiaChat/SofiaChat';

export default function MTalkChatPage() {
  const sp = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const { threadId } = useParams<{ threadId: string }>();

  // URL に cid が無ければ threadId を一度だけ付与
  const didReplaceRef = useRef(false);
  useEffect(() => {
    if (didReplaceRef.current) return;
    if (!threadId) return;

    const hasCid = !!sp.get('cid');
    if (!hasCid) {
      const q = new URLSearchParams(Array.from(sp.entries()));
      q.set('cid', threadId);
      didReplaceRef.current = true; // ★ replace前にセットして二重実行を防止
      router.replace(`${pathname}?${q.toString()}`, { scroll: false });
    } else {
      // すでに cid 付きで入ってきた場合も、このフラグを立てて以後は何もしない
      didReplaceRef.current = true;
    }
  // ⚠ sp は依存に入れない（オブジェクトが変わって毎回走るため）
  }, [threadId, pathname, router, sp]);

  // agent は mu / iros / mirra（既定は mirra）
  const agentParam = (sp.get('agent') || 'mirra').toLowerCase();
  const agent =
    agentParam === 'mu' || agentParam === 'iros' || agentParam === 'mirra' ? agentParam : 'mirra';

  return <SofiaChat agent={agent} />;
}
