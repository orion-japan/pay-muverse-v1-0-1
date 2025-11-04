// src/app/sofia/page.tsx
import SofiaChat from '@/components/SofiaChat/SofiaChat';

export const dynamic = 'force-dynamic';

type SearchParams = { agent?: string };
type Props = { searchParams: Promise<SearchParams> };

export default async function SofiaPage({ searchParams }: Props) {
  const sp = await searchParams;
  const agent = (sp?.agent ?? 'sofia').toLowerCase() as 'sofia' | 'iros' | 'mu' | 'mirra';

  if (process.env.NODE_ENV !== 'production') {
    console.log('[SofiaPage] agent param =', sp?.agent, '→ agent =', agent);
  }

  return (
    <main className="mu-main">
      <div className="sofia-page-wrap">
        <SofiaChat agent={agent} />
      </div>
    </main>
  );
}
