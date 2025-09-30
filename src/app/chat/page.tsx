import SofiaChat from '@/components/SofiaChat/SofiaChat';

export const dynamic = 'force-dynamic';

export default async function SofiaPage({
  searchParams,
}: {
  searchParams: Promise<{ open?: string }>;
}) {
  const { open } = await searchParams;

  return (
    <main className="mu-main">
      <div className="sofia-page-wrap">
        {/* Mu 固定。open は未指定なら undefined のまま渡す */}
        <SofiaChat agent="mu" open={typeof open === 'string' ? open : undefined} />
      </div>
    </main>
  );
}
