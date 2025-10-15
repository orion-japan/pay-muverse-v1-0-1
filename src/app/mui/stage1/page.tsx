// src/app/mui/stage1/page.tsx
// src/app/mui/stage1/page.tsx
import StageOnePanel from '@/components/mui/StageOnePanel';
import '@/components/mui/StageOnePanel.css';
export default async function Page({
  searchParams,
}: {
  // Next.js 15 の型にあわせて Promise で受ける
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const conv =
    Array.isArray(sp.conv) ? sp.conv[0] : (sp.conv ?? null);

  // user_code はCSR側で解決するなら固定で問題ありません
  const user_code = 'ANON';

  return <StageOnePanel user_code={user_code} conv={conv} />;
}
